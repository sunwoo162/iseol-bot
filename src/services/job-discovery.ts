import { createHash } from "node:crypto";
import { decodeScrapedHtml } from "./html-scrape-quality.js";

export type JobPosting = {
  kind: "채용"; title: string; url: string; company: string; host: string;
  sources: string[]; provider: "iseol-html"|"greenhouse"|"ashby"|"lever"|"lever-eu";
  boardKey: string; location: string; description: string; remote: boolean;
  minYears: number|null; status: string;
};
export type HtmlJobSource = {
  provider:"html"; company:string; listUrl:string; detailPathPrefix:string;
  maxPages?:number;
};
export type AtsJobSource = {
  provider:"greenhouse"|"ashby"|"lever"|"lever-eu"; company:string; board:string;
};
export type JobSource = HtmlJobSource|AtsJobSource;
export type JobSourceResult = {source:string;ok:true;jobs:JobPosting[]}
  | {source:string;ok:false;jobs:[];error:string};

const API_ORIGINS={
  greenhouse:"https://boards-api.greenhouse.io/v1/boards/",
  ashby:"https://api.ashbyhq.com/posting-api/job-board/",
  lever:"https://api.lever.co/v0/postings/",
  "lever-eu":"https://api.eu.lever.co/v0/postings/",
} as const;
const clean=(v:unknown,max=300)=>typeof v==="string"?v.replace(/[\u0000-\u001f]/g," ").replace(/\s+/g," ").trim().slice(0,max):"";
const plain=(html:unknown,max=6000)=>clean(typeof html==="string"?html.replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ").replace(/<[^>]*>/g," ").replace(/&(?:amp|nbsp|quot|lt|gt);/gi," "):"",max);
function safeHttps(value:unknown):URL {
  if(typeof value!=="string"||value.length>2048)throw new Error("Invalid URL");
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||url.port
    ||/^(?:localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(url.hostname))throw new Error("Unsafe URL");
  url.hash="";return url;
}
function validSource(value:unknown):value is JobSource {
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const s=value as Record<string,unknown>;
  if(!clean(s.company,80)||clean(s.company,80).length<2)return false;
  if(s.provider==="html"){
    if(typeof s.listUrl!=="string"||typeof s.detailPathPrefix!=="string"||
       !s.detailPathPrefix.startsWith("/")||s.detailPathPrefix.length>120)return false;
    try{safeHttps(s.listUrl.replace("{page}","1"));}catch{return false;}
    return s.maxPages===undefined||(Number.isSafeInteger(s.maxPages)&&Number(s.maxPages)>=1&&Number(s.maxPages)<=5);
  }
  return Object.hasOwn(API_ORIGINS,String(s.provider))
    &&typeof s.board==="string"&&/^[a-zA-Z0-9_-]{2,70}$/.test(s.board);
}
export function validateJobSources(value:unknown):JobSource[]{
  if(!Array.isArray(value)||value.length<1||value.length>12||!value.every(validSource))
    throw new Error("ISEOL_JOB_SOURCES_JSON: 1~12개 승인된 채용 소스가 필요합니다.");
  const keys=new Set<string>();
  for(const src of value){
    const key=src.provider==="html"?safeHttps(src.listUrl.replace("{page}","1")).origin+src.detailPathPrefix:src.provider+":"+src.board;
    if(keys.has(key))throw new Error("중복 채용 소스: "+key);keys.add(key);
  }
  return value as JobSource[];
}
export function loadJobSources(raw=process.env.ISEOL_JOB_SOURCES_JSON):JobSource[]{
  if(!raw?.trim())return [];
  let parsed:unknown;
  try{parsed=JSON.parse(raw);}catch{throw new Error("ISEOL_JOB_SOURCES_JSON JSON 형식 오류");}
  return validateJobSources(parsed);
}
function job(title:string,url:string,src:JobSource,description="",location="",remote=false):JobPosting {
  const provider=src.provider==="html"?"iseol-html":src.provider;
  const boardKey=src.provider==="html"
    ?"iseol-html:"+createHash("sha256").update(safeHttps(src.listUrl.replace("{page}","1")).origin).digest("hex").slice(0,16)
    :src.provider+":"+src.board;
  return {kind:"채용",title:clean(title,200),url,company:src.company,host:src.company,
    sources:[src.company],provider,boardKey,location:clean(location,120),
    description:plain(description),remote,minYears:null,status:"공식 지원 페이지에서 모집 상태와 자격 재확인"};
}
async function boundedFetch(fetchImpl:typeof fetch,url:string,html:boolean):Promise<unknown>{
  const response=await fetchImpl(url,{method:"GET",redirect:"error",
    headers:{Accept:html?"text/html,application/xhtml+xml":"application/json",
      "User-Agent":"IseolOpportunityCollector/1.0"},
    signal:AbortSignal.timeout(12000)});
  if(html)return (await decodeScrapedHtml(response,{context:url})).html;
  if(!response.ok)throw new Error("HTTP "+response.status);
  if(!(response.headers.get("content-type")??"application/json").toLowerCase().includes("json"))throw new Error("Unexpected content type");
  const raw=await response.text();
  if(Buffer.byteLength(raw)>2_000_000)throw new Error("Response too large");
  return JSON.parse(raw);
}
function hrefWithin(href:string,origin:string):string|null{
  try{
    const url=new URL(href,origin);
    if(url.origin!==origin||url.protocol!=="https:"||url.username||url.password||url.port)return null;
    url.hash="";return url.toString();
  }catch{return null;}
}
const anchorRx=/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
function candidates(html:string,src:HtmlJobSource):Map<string,string>{
  const origin=safeHttps(src.listUrl.replace("{page}","1")).origin;
  const rows=new Map<string,string>();
  for(const m of html.matchAll(anchorRx)){
    const url=hrefWithin(m[1]??"",origin);if(!url)continue;
    if(!new URL(url).pathname.startsWith(src.detailPathPrefix))continue;
    const title=plain(m[2]);if(title.length<4)continue;
    rows.set(url,title);
  }
  return rows;
}
async function collectHtml(src:HtmlJobSource,fetchImpl:typeof fetch):Promise<JobPosting[]>{
  const all=new Map<string,string>();
  const pages=src.maxPages??2;
  for(let page=1;page<=pages;page++){
    const listUrl=src.listUrl.includes("{page}")?src.listUrl.replace("{page}",String(page)):src.listUrl;
    const html=await boundedFetch(fetchImpl,safeHttps(listUrl).toString(),true) as string;
    const current=candidates(html,src);
    if(page===1&&current.size===0)throw new Error("HTML_STRUCTURE: No job anchors at configured path");
    if(!current.size||[...current.keys()].every(url=>all.has(url)))break;
    for(const [url,title] of current)all.set(url,title);
    if(!src.listUrl.includes("{page}"))break;
  }
  const jobs:JobPosting[]=[];
  for(const [url,title] of all){
    const html=await boundedFetch(fetchImpl,url,true) as string;
    const heading=plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1])||
      plain(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1])||title;
    const description=html.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']+)/i)?.[1]??html;
    jobs.push(job(heading,url,src,description));
  }
  return jobs;
}
function normalizeAts(src:AtsJobSource,raw:unknown):JobPosting|null {
  if(!raw||typeof raw!=="object")return null;
  const entry=raw as Record<string,unknown>;
  let title="",url="",description="",location="",remote=false;
  if(src.provider==="greenhouse"){
    title=clean(entry.title);url=clean(entry.absolute_url,2048);
    description=clean(entry.content,12000);
    location=clean((entry.location as {name?:unknown}|undefined)?.name);
  }else if(src.provider==="ashby"){
    if(entry.isListed===false)return null;
    title=clean(entry.title);url=clean(entry.jobUrl,2048);
    description=clean(entry.descriptionPlain??entry.descriptionHtml,12000);
    location=clean(entry.location);remote=entry.isRemote===true;
  }else{
    title=clean(entry.text);url=clean(entry.hostedUrl,2048);
    const lists=Array.isArray(entry.lists)?entry.lists.slice(0,12).map(v=>clean((v as {content?:unknown}).content,1400)).join(" "):"";
    description=clean((entry.descriptionPlain??entry.description) as unknown,10000)+" "+lists;
    location=clean((entry.categories as {location?:unknown}|undefined)?.location);
    remote=entry.workplaceType==="remote";
  }
  if(title.length<4)return null;
  let parsed:URL;
  try{parsed=safeHttps(url);}catch{return null;}
  const expected=src.provider==="greenhouse"?"greenhouse.io":
    src.provider==="ashby"?"ashbyhq.com":"lever.co";
  if(!parsed.hostname.endsWith("."+expected)&&parsed.hostname!==expected)return null;
  return job(title,parsed.toString(),src,description,location,remote);
}
async function collectAts(src:AtsJobSource,fetchImpl:typeof fetch):Promise<JobPosting[]> {
  const base=API_ORIGINS[src.provider]+encodeURIComponent(src.board);
  const url=src.provider==="greenhouse"?base+"/jobs?content=true":
    src.provider==="ashby"?base:base+"?mode=json";
  const jobs:JobPosting[]=[];
  if(src.provider==="lever"||src.provider==="lever-eu"){
    let complete=false;
    for(let skip=0;skip<1000;skip+=100){
      const batch=await boundedFetch(fetchImpl,url+"&skip="+skip+"&limit=100",false);
      if(!Array.isArray(batch)||batch.length>100)throw new Error("Invalid Lever page");
      for(const raw of batch){const j=normalizeAts(src,raw);if(j)jobs.push(j);}
      if(batch.length<100){complete=true;break;}
    }
    if(!complete)throw new Error("Lever full pagination could not be verified");
  }else{
    const raw=await boundedFetch(fetchImpl,url,false) as {jobs?:unknown};
    if(!raw||!Array.isArray(raw.jobs)||raw.jobs.length>1000)throw new Error("Invalid ATS response");
    for(const item of raw.jobs){const j=normalizeAts(src,item);if(j)jobs.push(j);}
  }
  return [...new Map(jobs.map(j=>[j.url,j])).values()];
}
export async function collectJobSources(sources:JobSource[],{fetchImpl=fetch,log=console.warn}:
  {fetchImpl?:typeof fetch;log?:(message:string)=>void}={}):Promise<JobSourceResult[]>{
  const results:JobSourceResult[]=[];
  for(const source of validateJobSources(sources)){
    const name=source.company+" ("+source.provider+")";
    try{
      const jobs=source.provider==="html"?await collectHtml(source,fetchImpl):await collectAts(source,fetchImpl);
      if(!jobs.length)throw new Error("No verified jobs (source page/structure may have changed)");
      results.push({source:name,ok:true,jobs});
    }catch(error){
      const message=error instanceof Error?error.message:"Unknown error";
      log("ISEOL_JOB_SCRAPE_HEALTH "+JSON.stringify({source:name,ok:false,error:message.slice(0,240)}));
      results.push({source:name,ok:false,jobs:[],error:message});
    }
  }
  return results;
}
