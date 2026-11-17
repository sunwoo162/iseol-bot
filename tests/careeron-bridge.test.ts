import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CareerOnContestBridge, type CareerOnBridgeOptions } from "../src/services/careeron-bridge.js";

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
