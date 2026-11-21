import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EmbedBuilder, TextChannel, type Client } from "discord.js";
import { withDurableFileStateLock } from "./file-state-lock.js";
import { collectJobSources, loadJobSources, type JobPosting, type JobSourceResult } from "./job-discovery.js";
import { millisecondsUntilNextKstNine } from "./contest-discovery-scheduler.js";

const MAX_DISCORD_POSTS_PER_RUN=25;
const DAILY_OFFSET_MS=10*60_000;
const RETRY_DELAY_MS=15*60_000;
const DEFAULT_DATA_DIR=resolve(process.cwd(),"data");
const key=(job:JobPosting)=>createHash("sha256").update(job.url).digest("hex");
const validId=(value:string)=>/^\d{15,25}$/.test(value);
export function getConfiguredJobChannels(raw=process.env.ISEOL_JOB_DISCORD_CHANNEL_IDS):string[]{
  return [...new Set((raw??"").split(",").map(v=>v.trim()).filter(Boolean))].map(value=>{
    if(!validId(value))throw new Error("Invalid ISEOL_JOB_DISCORD_CHANNEL_IDS");
    return value;
  });
}
async function loadPosted(file:string):Promise<string[]>{
  try{
    const data:unknown=JSON.parse(await readFile(file,"utf8"));
    if(!Array.isArray(data)||data.length>10000||
       data.some(v=>typeof v!=="string"||!/^[0-9a-f]{64}$/.test(v)))throw new Error("Invalid job notification state");
    return data as string[];
  }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
}
async function persist(file:string,items:string[]):Promise<void>{
  await mkdir(dirname(file),{recursive:true});
  const temp=file+"."+process.pid+"."+randomBytes(4).toString("hex")+".tmp";
  await writeFile(temp,JSON.stringify(items),"utf8");
  await rename(temp,file);
}
/** Acknowledge each successful send; failed sends remain eligible for next poll. */
export async function publishNewJobCards(jobs:JobPosting[],options:{
  stateFile:string; send:(job:JobPosting)=>Promise<unknown>;limit?:number;
}):Promise<{posted:number;remaining:number}>{
  const {stateFile,send,limit=MAX_DISCORD_POSTS_PER_RUN}=options;
  return withDurableFileStateLock(stateFile,async()=>{
    const history=await loadPosted(stateFile),seen=new Set(history);
    let posted=0,remaining=0;
    const unique=[...new Map(jobs.map(job=>[key(job),job])).values()];
    for(const job of unique){
      const id=key(job);if(seen.has(id))continue;
      if(posted>=limit){remaining++;continue;}
      await send(job);
      history.push(id);seen.add(id);posted++;
      await persist(stateFile,history.slice(-8000));
    }
    return {posted,remaining};
  },{waitForMs:30_000});
}
function renderJob(job:JobPosting):EmbedBuilder{
  const embed=new EmbedBuilder().setColor(0x4377bc)
    .setTitle(("💼 "+job.title).slice(0,250))
    .setURL(job.url)
    .setDescription((job.description||"지원 요건 및 마감일은 반드시 공식 공고를 확인해 주세요.").slice(0,1000))
    .addFields(
      {name:"기업",value:job.company.slice(0,256),inline:true},
      {name:"근무 위치",value:(job.location||"원문 확인").slice(0,256),inline:true},
      {name:"출처",value:job.provider.slice(0,256),inline:true},
    )
    .setFooter({text:"이설 · 공고 원문 우선 · 최신 모집 여부 확인 필수"});
  return embed;
}
async function sendToConfiguredChannels(client:Client,jobs:JobPosting[]):Promise<void>{
  const ids=getConfiguredJobChannels();
  for(const id of ids){
    const channel=await client.channels.fetch(id);
    if(!(channel instanceof TextChannel))throw new Error("Configured job channel is not a Discord text channel: "+id);
    const stateFile=join(process.env.ISEOL_JOB_FEED_DATA_DIR?.trim()||DEFAULT_DATA_DIR,"job-feed-"+id+".json");
    const result=await publishNewJobCards(jobs,{stateFile,send:job=>channel.send({
      embeds:[renderJob(job)],allowedMentions:{parse:[]},
    })});
    console.log("ISEOL_JOB_DISCORD "+JSON.stringify({channel:id,...result}));
  }
}
/** Starts once at bot readiness. Jobs and contests share discovery inputs only; both sinks fail independently. */
export function startJobFeedPolling(
  client:Client,
  syncCareerOnJobs?:((jobs:JobPosting[])=>Promise<void>)|null,
  options:{collect?:(sources:ReturnType<typeof loadJobSources>)=>Promise<JobSourceResult[]>;now?:()=>number}={},
):void{
  let sources:ReturnType<typeof loadJobSources>;
  try{sources=loadJobSources();}catch(e){console.error("ISEOL_JOB_CONFIG",e);return;}
  if(!sources.length){
    console.log("ISEOL_JOB_SOURCES_JSON 미설정: 채용 수집 비활성 (기존 공모전 수집 정상 유지)");
    return;
  }
  const collect=options.collect??(src=>collectJobSources(src));
  const now=options.now??Date.now;
  let running=false;
  const schedule=(delay:number)=>{
    const timer=setTimeout(()=>{void refresh("scheduled");},delay);timer.unref?.();
  };
  const refresh=async(reason:"startup"|"scheduled")=>{
    if(running)return;
    running=true;
    let retry=false;
    try{
      const results=await collect(sources);
      const success=results.filter((r):r is Extract<JobSourceResult,{ok:true}>=>r.ok);
      const failed=results.filter(r=>!r.ok);
      if(failed.length)retry=true;
      if(!success.length)throw new Error("모든 채용 소스 수집 실패");
      const jobs=[...new Map(success.flatMap(r=>r.jobs).map(j=>[j.url,j])).values()];
      console.log("ISEOL_JOB_DISCOVERY "+JSON.stringify({reason,jobs:jobs.length,successfulSources:success.length,failedSources:failed.length}));
      if(jobs.length){
        const sinks=await Promise.allSettled([
          sendToConfiguredChannels(client,jobs),
          syncCareerOnJobs?.(jobs)??Promise.resolve(),
        ]);
        for(const result of sinks)if(result.status==="rejected"){
          retry=true;
          console.error("ISEOL_JOB_DELIVERY",result.reason instanceof Error?result.reason.message:String(result.reason));
        }
      }
    }catch(e){
      retry=true;
      console.error("ISEOL_JOB_DISCOVERY_FAILED",e instanceof Error?e.message:String(e));
    }finally{
      running=false;
      // Retry transient errors quickly, otherwise run at the next 09:10 KST.
      schedule(retry?RETRY_DELAY_MS:millisecondsUntilNextKstNine(now())+DAILY_OFFSET_MS);
    }
  };
  void refresh("startup");
}
