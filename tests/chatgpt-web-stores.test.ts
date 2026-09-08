import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWebWorkerSession,
  getActiveWebWorkerSession,
  loadWebWorkerSession,
  replaceLostWebWorkerSession,
} from "../src/chatgpt-web/session-store.js";
import { appendReasoningTurn, listReasoningTurns } from "../src/chatgpt-web/turn-store.js";
import { loadDesktopIntent, recordDesktopIntent } from "../src/chatgpt-web/intent-store.js";

async function root() { return mkdtemp(join(tmpdir(), "iseol-chatgpt-store-")); }
const session1 = {
  version: 1 as const, sessionId: "session-1", runId: "run-1", stage: "IMPLEMENT" as const,
  generation: 1, policySha256: "policy-1", status: "ready" as const,
  createdAt: "2026-09-08T01:00:00.000Z",
};
test("session store keeps one active generation and replaces lost sessions", async () => {
  const store = await root();
  await createWebWorkerSession(store, session1);
  assert.equal((await getActiveWebWorkerSession(store, "run-1", "IMPLEMENT"))?.sessionId, "session-1");
  await assert.rejects(
    createWebWorkerSession(store, { ...session1, sessionId: "session-other" }),
    /active.*session/i,
  );

  const replacement = { ...session1, sessionId: "session-2", generation: 2, createdAt: "2026-09-08T01:02:00.000Z" };
  await replaceLostWebWorkerSession(store, "session-1", replacement, "2026-09-08T01:02:00.000Z");
  assert.equal((await loadWebWorkerSession(store, "session-1"))?.status, "lost");
  assert.equal((await getActiveWebWorkerSession(store, "run-1", "IMPLEMENT"))?.sessionId, "session-2");
  assert.equal((await getActiveWebWorkerSession(store, "run-1", "IMPLEMENT"))?.generation, 2);
});

test("session store rejects unsafe ids and invalid replacement generation", async () => {
  const store = await root();
  await assert.rejects(createWebWorkerSession(store, { ...session1, sessionId: "../escape" }), /sessionId/i);
  await createWebWorkerSession(store, session1);
  await assert.rejects(
    replaceLostWebWorkerSession(store, "session-1", { ...session1, sessionId: "session-3", generation: 3 }, "2026-09-08T01:02:00.000Z"),
    /generation/i,
  );
});
test("reasoning turns append once by semantic identity", async () => {
  const store = await root();
  const turn = {
    version: 1 as const, turnId: "turn-1", sessionId: "session-1", runId: "run-1",
    stage: "IMPLEMENT" as const, generation: 1, promptSha256: "prompt", responseSha256: "response",
    summary: "Apply patch", decisions: ["Keep API"], desktopIntentIds: ["intent-1"],
    outcome: "continue" as const, recordedAt: "2026-09-08T01:03:00.000Z",
  };
  assert.equal(await appendReasoningTurn(store, turn), true);
  assert.equal(await appendReasoningTurn(store, { ...turn, recordedAt: "2026-09-08T01:03:01.000Z" }), false);
  await assert.rejects(appendReasoningTurn(store, { ...turn, summary: "Different" }), /identity mismatch/i);
  assert.equal((await listReasoningTurns(store, "run-1")).length, 1);
});

test("desktop intent records are idempotent and reject credential-shaped input", async () => {
  const store = await root();
  const intent = {
    version: 1 as const, intentId: "intent-1", runId: "run-1", stage: "IMPLEMENT" as const,
    workspaceRoot: "C:/workspace/project", policySha256: "policy-1", kind: "GIT_INSPECT" as const, cwd: ".",
  };
  const input = { intent, status: "accepted" as const, recordedAt: "2026-09-08T01:04:00.000Z" };
  const first = await recordDesktopIntent(store, input);
  const second = await recordDesktopIntent(store, { ...input, recordedAt: "2026-09-08T01:04:01.000Z" });
  assert.equal(first.intent.intentId, second.intent.intentId);
  await assert.rejects(recordDesktopIntent(store, { ...input, intent: { ...intent, cwd: "src" } }), /identity conflict/i);
  await assert.rejects(recordDesktopIntent(store, { ...input, cookie: "secret-cookie" } as any), /unexpected.*field/i);
  const loaded = await loadDesktopIntent(store, "run-1", "intent-1");
  assert.equal(loaded?.status, "accepted");
  assert.equal(JSON.stringify(loaded).includes("secret-cookie"), false);
});
