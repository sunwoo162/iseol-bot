import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CareerOnContestBridge, resolveCareerOnOutboxFile, type CareerOnBridgeOptions } from "../src/services/careeron-bridge.js";

const contest = {
  title: "청소년 AI 아이디어 공모전",
  url: "https://www.wevity.com/?ix=12345",
  sources: ["위비티" as const],
  field: "인공지능",
  target: "고등학생",
  host: "주최기관",
  sponsor: "협찬기관",
  period: "2026.11.01 ~ 2026.12.01",
  totalPrize: "500만원",
  firstPrize: "300만원",
  homepage: "https://example.org/contest",
  attachments: [{ name: "공고.pdf", url: "https://example.org/notice.pdf" }],
};
const secret = "careeron-bridge-test-secret-which-is-at-least-32-characters";
const fixedNow = Date.parse("2026-11-17T01:00:00Z");

test("CareerOn outbox resolves to a shared data path instead of a release-local folder", () => {
  const releaseDirectory = join(tmpdir(), "iseol", "releases", "release-1");
  const sharedPath = join(tmpdir(), "iseol", "data", "careeron-opportunity-outbox.json");
  assert.equal(resolveCareerOnOutboxFile(releaseDirectory, sharedPath), sharedPath);
  assert.equal(resolveCareerOnOutboxFile(releaseDirectory), join(releaseDirectory, "data", "careeron-opportunity-outbox.json"));
});

async function withOutbox(run: (options: CareerOnBridgeOptions, file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "iseol-careeron-"));
  const file = join(directory, "outbox.json");
  try {
    await run({ endpoint: "https://careeron.example/api/integrations/iseol/opportunities", secret, outboxFile: file, now: () => fixedNow }, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("Iseol sends only public contest data with the CareerOn HMAC contract", async () => {
  await withOutbox(async (options, file) => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const bridge = new CareerOnContestBridge({
      ...options,
      listContests: async () => [contest],
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init };
        return new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 200 });
      },
    });
    const result = await bridge.syncOnce();
    assert.deepEqual(result, { discovered: 1, delivered: 1, pending: 0 });
    assert.ok(captured);
    const headers = new Headers(captured.init?.headers);
    const rawBody = String(captured.init?.body);
    const timestamp = headers.get("x-iseol-timestamp") ?? "";
    assert.equal(headers.get("x-iseol-signature"), `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`);
    const payload = JSON.parse(rawBody);
    assert.equal(payload.contests[0].title, contest.title);
    assert.equal(payload.contests[0].kind, "공모전");
    assert.equal("guildId" in payload.contests[0], false);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), []);
  });
});

test("Iseol retains failed CareerOn deliveries and retries them on a later poll", async () => {
  await withOutbox(async options => {
    let calls = 0;
    const bridge = new CareerOnContestBridge({
      ...options,
      listContests: async () => [contest],
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? new Response("temporarily unavailable", { status: 503 })
          : new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 200 });
      },
      log: () => undefined,
    });
    const first = await bridge.syncOnce();
    assert.deepEqual(first, { discovered: 1, delivered: 0, pending: 1 });
    const second = await bridge.syncOnce();
    assert.deepEqual(second, { discovered: 1, delivered: 1, pending: 0 });
    assert.equal(calls, 2);
  });
});

test("Iseol flushes an already durable batch even when the next contest discovery fails", async () => {
  await withOutbox(async options => {
    let discoveryFails = false;
    let sends = 0;
    const bridge = new CareerOnContestBridge({
      ...options,
      listContests: async () => {
        if (discoveryFails) throw new Error("source unavailable");
        return [contest];
      },
      fetchImpl: async () => {
        sends++;
        return sends === 1
          ? new Response("temporarily unavailable", { status: 503 })
          : new Response(JSON.stringify({ ok: true, accepted: 1 }), { status: 200 });
      },
      log: () => undefined,
    });

    assert.deepEqual(await bridge.syncOnce(), { discovered: 1, delivered: 0, pending: 1 });
    discoveryFails = true;
    assert.deepEqual(await bridge.syncOnce(), { discovered: 0, delivered: 1, pending: 0 });
    assert.equal(sends, 2);
  });
});

test("Iseol refuses to overwrite a malformed outbox and preserves it for operator recovery", async () => {
  await withOutbox(async (options, file) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify([{ sourceId: "missing-contest-payload" }]), "utf8");
    const bridge = new CareerOnContestBridge({ ...options, listContests: async () => [], fetchImpl: async () => new Response("unexpected"), log: () => undefined });

    await assert.rejects(bridge.syncOnce(), /invalid entries/);
    assert.equal(await readFile(file, "utf8"), JSON.stringify([{ sourceId: "missing-contest-payload" }]));
  });
});

test("Iseol reuses its signed durable outbox for job postings and retries failed batches",async()=>{
  await withOutbox(async (options,file)=>{
    const job={
      kind:"채용" as const,title:"Product Engineer",
      url:"https://jobs.example.org/jobs/2027",company:"Example Labs",host:"Example Labs",
      sources:["Example Labs"],provider:"iseol-html" as const,boardKey:"iseol-html:abc",
      location:"Seoul",description:"Java Spring Kafka",remote:false,
      minYears:null,status:"원문 확인 필요",
    };
    let attempts=0;
    let received:unknown=null;
    const bridge=new CareerOnContestBridge({...options,fetchImpl:async(_url,init)=>{
      attempts++;
      received=JSON.parse(String(init?.body));
      return attempts===1?new Response("Temporary error",{status:503}):new Response(JSON.stringify({ok:true}),{status:200});
    },log:()=>undefined});
    const failed=await bridge.syncJobs([job]);
    assert.deepEqual(failed,{discovered:1,delivered:0,pending:1});
    const payload=received as {contests:Array<{kind:string;company:string;url:string}>};
    assert.equal(payload.contests[0]?.kind,"채용");
    assert.equal(payload.contests[0]?.company,"Example Labs");
    assert.equal(payload.contests[0]?.url,job.url);
    assert.equal(JSON.parse(await readFile(file,"utf8")).length,1);
    const recovered=await bridge.flushPending();
    assert.deepEqual(recovered,{delivered:1,pending:0});
    assert.equal(attempts,2);
    assert.deepEqual(JSON.parse(await readFile(file,"utf8")),[]);
  });
});
