import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHarnessPolicy } from "../src/harness/policy-resolver.js";
import type { HarnessRuntimeRunEnvelope } from "../src/harness/contracts.js";
import { createWebReasoningExecutor } from "../src/chatgpt-web/web-reasoning-executor.js";
import { createFakeChatGptWebBrowserAdapter, ChatGptWebSessionLostError } from "../src/chatgpt-web/test-support/fake-browser-adapter.js";
import { getActiveWebWorkerSession } from "../src/chatgpt-web/session-store.js";
import { listReasoningTurns } from "../src/chatgpt-web/turn-store.js";
import { loadDesktopIntent } from "../src/chatgpt-web/intent-store.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "iseol-web-reasoning-"));
  const repo = join(root, "repo");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "HARNESS_ENGINEERING.md"), "# Global Harness\n", "utf8");
  await writeFile(join(repo, "docs", "HARNESS_ENGINEERING.md"), "# Project Harness\n", "utf8");
  const policy = await resolveHarnessPolicy({ iseolRoot: root, targetRoot: repo, loadedAt: "2026-09-08T01:00:00.000Z" });
  const run: HarnessRuntimeRunEnvelope = {
    version: 1,
    request: { version: 1, runId: "run-web", mode: "project-workspace", objective: "Implement web bridge", targetRoot: repo },
    preflight: { version: 1, runId: "run-web", status: "ready", policy },
    state: { version: 1, stage: "IMPLEMENT", status: "RUNNING", completedStages: [], skippedStages: [], updatedAt: "2026-09-08T01:00:00.000Z" },
    evidence: [], updatedAt: "2026-09-08T01:00:00.000Z",
  };
  return { root, repo, run };
}
test("reasoning stage loops through Desktop feedback and completes from structured output", async () => {
  const { root, repo, run } = await fixture();
  const policySha256 = run.preflight.policy!.effectiveSha256;
  const intent = { version: 1 as const, intentId: "intent-patch", runId: "run-web", stage: "IMPLEMENT" as const, workspaceRoot: repo, policySha256, kind: "PROPOSE_PATCH" as const, path: "feature.txt", patch: "--- a/feature.txt\n+++ b/feature.txt\n@@ -1 +1 @@\n-old\n+new\n" };
  const fake = createFakeChatGptWebBrowserAdapter([
    { version: 1, runId: "run-web", stage: "IMPLEMENT", generation: 1, summary: "Patch the feature", decisions: ["Use one guarded patch"], intents: [intent], outcome: "continue" },
    { version: 1, runId: "run-web", stage: "IMPLEMENT", generation: 1, summary: "Implementation is complete", decisions: ["Patch verified"], intents: [], outcome: "stage-complete" },
  ]);
  const desktopCalls: string[] = [];
  const executor = createWebReasoningExecutor({
    workerRoot: root,
    adapter: fake.adapter,
    now: () => "2026-09-08T01:01:00.000Z",
    runDesktopIntent: async ({ intent: item }) => {
      desktopCalls.push(item.intentId);
      return { type: "completed", evidence: [{ version: 1, id: "evidence-patch", kind: "file-change", stage: "IMPLEMENT", recordedAt: "2026-09-08T01:01:00.000Z", summary: "Patched feature.txt", provider: "iseol-desktop-agent", reference: "desktop-job:patch" }] };
    },
  });

  const result = await executor.execute(run);
  assert.equal(result.type, "completed");
  assert.deepEqual(desktopCalls, ["intent-patch"]);
  assert.equal(fake.submittedPrompts.length, 2);
  assert.match(fake.submittedPrompts[1]!.body, /Patched feature\.txt/);
  assert.equal((await listReasoningTurns(root, "run-web")).length, 2);
  assert.equal((await loadDesktopIntent(root, "run-web", "intent-patch"))?.status, "accepted");
  assert.equal((await getActiveWebWorkerSession(root, "run-web", "IMPLEMENT"))?.generation, 1);
  assert.equal("sendTask" in fake.adapter, false);
});
test("blocked-user and Desktop waiting-agent propagate without stage completion", async () => {
  const blocked = await fixture();
  const blockedFake = createFakeChatGptWebBrowserAdapter([
    { version: 1, runId: "run-web", stage: "IMPLEMENT", generation: 1, summary: "Need a product decision", decisions: [], intents: [], outcome: "blocked-user", blockerReason: "Choose A or B" },
  ]);
  const blockedExecutor = createWebReasoningExecutor({ workerRoot: blocked.root, adapter: blockedFake.adapter, now: () => "2026-09-08T01:02:00.000Z", runDesktopIntent: async () => { throw new Error("desktop should not run"); } });
  assert.deepEqual(await blockedExecutor.execute(blocked.run), { type: "blocked-user", reason: "Choose A or B" });

  const waiting = await fixture();
  const policySha256 = waiting.run.preflight.policy!.effectiveSha256;
  const waitingFake = createFakeChatGptWebBrowserAdapter([
    { version: 1, runId: "run-web", stage: "IMPLEMENT", generation: 1, summary: "Inspect repository", decisions: [], intents: [{ version: 1, intentId: "intent-inspect", runId: "run-web", stage: "IMPLEMENT", workspaceRoot: waiting.repo, policySha256, kind: "GIT_INSPECT", cwd: "." }], outcome: "continue" },
  ]);
  const waitingExecutor = createWebReasoningExecutor({ workerRoot: waiting.root, adapter: waitingFake.adapter, now: () => "2026-09-08T01:02:00.000Z", runDesktopIntent: async () => ({ type: "waiting-agent", reason: "Desktop offline" }) });
  assert.deepEqual(await waitingExecutor.execute(waiting.run), { type: "waiting-agent", reason: "Desktop offline" });
});

test("turn and rejection budgets are bounded", async () => {
  const turns = await fixture();
  const continueResult = { version: 1 as const, runId: "run-web", stage: "IMPLEMENT" as const, generation: 1, summary: "Still working", decisions: [], intents: [], outcome: "continue" as const };
  const turnFake = createFakeChatGptWebBrowserAdapter([continueResult, continueResult]);
  const turnExecutor = createWebReasoningExecutor({ workerRoot: turns.root, adapter: turnFake.adapter, maxTurnsPerStage: 2, now: () => "2026-09-08T01:03:00.000Z", runDesktopIntent: async () => { throw new Error("unused"); } });
  const turnResult = await turnExecutor.execute(turns.run);
  assert.equal(turnResult.type, "retryable-failure");
  assert.match(turnResult.reason, /turn budget/i);

  const rejected = await fixture();
  const policySha256 = rejected.run.preflight.policy!.effectiveSha256;
  const unsafeIntent = { version: 1 as const, intentId: "unsafe-1", runId: "run-web", stage: "IMPLEMENT" as const, workspaceRoot: rejected.repo, policySha256, kind: "READ_CONTEXT" as const, path: "../secret.txt" };
  const rejectFake = createFakeChatGptWebBrowserAdapter([
    { version: 1, runId: "run-web", stage: "IMPLEMENT", generation: 1, summary: "Read outside", decisions: [], intents: [unsafeIntent], outcome: "continue" },
  ]);
  const rejectExecutor = createWebReasoningExecutor({ workerRoot: rejected.root, adapter: rejectFake.adapter, maxRejectedIntents: 1, now: () => "2026-09-08T01:03:00.000Z", runDesktopIntent: async () => { throw new Error("rejected intent must not run"); } });
  const rejectResult = await rejectExecutor.execute(rejected.run);
  assert.equal(rejectResult.type, "retryable-failure");
  assert.match(rejectResult.reason, /rejected intent/i);
  assert.equal((await loadDesktopIntent(rejected.root, "run-web", "unsafe-1"))?.status, "rejected");
});
test("malformed structured results use the same bounded rejection budget", async () => {
  const { root, run } = await fixture();
  const fake = createFakeChatGptWebBrowserAdapter([
    { version: 1, runId: "run-web", stage: "IMPLEMENT", generation: 1, summary: "missing outcome", decisions: [], intents: [] },
    { version: 1, runId: "run-web", stage: "IMPLEMENT", generation: 1, summary: "still malformed", decisions: [], intents: [] },
  ]);
  const executor = createWebReasoningExecutor({
    workerRoot: root,
    adapter: fake.adapter,
    maxRejectedIntents: 2,
    now: () => "2026-09-08T01:04:00.000Z",
    runDesktopIntent: async () => { throw new Error("unused"); },
  });
  const result = await executor.execute(run);
  assert.equal(result.type, "retryable-failure");
  assert.match(result.reason, /rejected reasoning result budget/i);
  assert.equal(fake.submittedPrompts.length, 2);
});