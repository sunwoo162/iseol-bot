import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectJobSources, loadJobSources, validateJobSources, type JobPosting } from "../src/services/job-discovery.js";
import { getConfiguredJobChannels, publishNewJobCards } from "../src/services/job-feed.js";

const htmlSource={provider:"html" as const,company:"Demo Tech",
  listUrl:"https://jobs.example.org/careers?page={page}",detailPathPrefix:"/jobs/",maxPages:2};
const atsSource={provider:"greenhouse" as const,company:"Demo GH",board:"demo-board"};
const sample:JobPosting={kind:"채용",title:"Product Engineer",company:"Demo Tech",
  host:"Demo Tech",sources:["Demo Tech"],url:"https://jobs.example.org/jobs/101",
  provider:"iseol-html",boardKey:"iseol-html:abc",location:"Seoul",description:"Java, Kafka",
  remote:false,minYears:null,status:"공식 공고 확인 필요"};
const okHtml=(text:string)=>new Response(text,{headers:{"content-type":"text/html; charset=utf-8"}});
test("job provider config rejects unsafe links, duplicates and malformed sources",()=>{
  assert.deepEqual(loadJobSources(""),[]);
  assert.deepEqual(validateJobSources([htmlSource,atsSource]).map(s=>s.provider),["html","greenhouse"]);
  assert.throws(()=>loadJobSources("{bad"),/JSON/);
  assert.throws(()=>validateJobSources([htmlSource,htmlSource]),/중복/);
  for(const link of ["http://jobs.example.org/jobs","https://localhost/jobs","https://127.0.0.1/jobs","https://someone:pass@jobs.example.org/jobs"]){
    assert.throws(()=>validateJobSources([{...htmlSource,listUrl:link}]),/소스/);
  }
});
test("HTML listing and detail pages become normalized jobs, and duplicates are removed",async()=>{
  const calls:string[]=[];
  const [result]=await collectJobSources([htmlSource],{fetchImpl:async input=>{
    const url=String(input);calls.push(url);
    if(url.includes("page=1"))return okHtml("<html><title>채용 공고</title><a href='/jobs/101'>Product Engineer</a><a href='/jobs/101'>Product Engineer</a></html>");
    if(url.includes("page=2"))return okHtml("<html><title>더 이상 공고 없음</title><p>현재 공고 없음</p></html>");
    return okHtml('<html><title>Product Engineer</title><h1>Product Engineer - Platform</h1><meta name="description" content="Java Kafka and Kubernetes"/></html>');
  },log:()=>undefined});
  assert.equal(result.ok,true);
  assert.equal(result.jobs.length,1);
  assert.equal(result.jobs[0]?.kind,"채용");
  assert.equal(result.jobs[0]?.company,"Demo Tech");
  assert.equal(result.jobs[0]?.title,"Product Engineer - Platform");
  assert.deepEqual(calls,["https://jobs.example.org/careers?page=1","https://jobs.example.org/careers?page=2","https://jobs.example.org/jobs/101"]);
});
test("invalid markup, an inaccessible detail and empty first list fail safely",async()=>{
  for(const scenario of ["broken","detail","empty"]){
    const [result]=await collectJobSources([htmlSource],{fetchImpl:async input=>{
      const url=String(input);
      if(url.includes("page=1")){
        if(scenario==="broken")return okHtml("<html><title>채� 공고</title><body>broken page</body></html>");
        if(scenario==="empty")return okHtml("<html><title>홈페이지</title><p>내용만 있음</p></html>");
        return okHtml("<html><a href='/jobs/101'>Product Engineer</a></html>");
      }
      if(url.includes("page=2"))return okHtml("<html><p>No jobs on page</p></html>");
      return new Response("rate limited",{status:429});
    },log:()=>undefined});
    assert.equal(result.ok,false,scenario);
    assert.equal(result.jobs.length,0,scenario);
  }
});
test("Greenhouse ATS remains read-only and per-source HTTP failures do not block others",async()=>{
  const calls:{url:string;method:string|undefined}[]=[];
  const results=await collectJobSources([atsSource,htmlSource],{fetchImpl:async(input,init)=>{
    const url=String(input);calls.push({url,method:init?.method});
    if(url.startsWith("https://boards-api.greenhouse.io"))return new Response(JSON.stringify({jobs:[
      {id:101,title:"Backend Engineer",absolute_url:"https://boards.greenhouse.io/demo/jobs/101",
       content:"<p>Spring Kafka</p>",location:{name:"Seoul"}}
    ]}),{headers:{"content-type":"application/json"}});
    return new Response("429",{status:429});
  },log:()=>undefined});
  assert.deepEqual(results.map(r=>r.ok),[true,false]);
  assert.equal(results[0]?.jobs[0]?.title,"Backend Engineer");
  assert.ok(calls.every(x=>x.method==="GET"));
});
test("Discord job publishing remembers completed sends and retries failed sends",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"iseol-job-feed-")),stateFile=join(dir,"sent.json");
  try{
    const other={...sample,url:"https://jobs.example.org/jobs/102",title:"Other Engineer"};
    const sent:string[]=[];
    let shouldFail=true;
    await assert.rejects(publishNewJobCards([sample,other],{stateFile,send:async job=>{
      if(job.url===other.url&&shouldFail)throw new Error("Discord 503");
      sent.push(job.url);
    }}),/Discord 503/);
    assert.deepEqual(sent,[sample.url]);
    const after=await publishNewJobCards([sample,other,sample],{stateFile,send:async job=>{
      sent.push(job.url);shouldFail=false;
    }});
    assert.deepEqual(after,{posted:1,remaining:0});
    assert.deepEqual(sent,[sample.url,other.url]);
    const final=await publishNewJobCards([sample,other],{stateFile,send:async()=>{throw new Error("duplicate send");}});
    assert.equal(final.posted,0);
    assert.equal((JSON.parse(await readFile(stateFile,"utf8")) as string[]).length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test("malformed Discord send state is preserved and blocks accidental duplicate replays",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"iseol-job-feed-")),stateFile=join(dir,"sent.json");
  try{
    await writeFile(stateFile,'{"corrupt":true}');
    await assert.rejects(publishNewJobCards([sample],{stateFile,send:async()=>{throw new Error("should not post");}}),/Invalid job notification state/);
    assert.equal(await readFile(stateFile,"utf8"),'{"corrupt":true}');
    assert.deepEqual(getConfiguredJobChannels("123456789012345,123456789012345,987654321098765"),
      ["123456789012345","987654321098765"]);
    assert.throws(()=>getConfiguredJobChannels("not-a-channel"),/Invalid/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
