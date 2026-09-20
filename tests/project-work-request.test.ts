import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimProjectWorkRequest,
  createProjectWorkRequest,
  executeProjectWorkRequest,
  listProjectWorkRequests,
  updateProjectWorkRequest,
} from "../src/project-model/work-request.js";

const at = "2026-09-20T12:00:00.000Z";

test("work request creation is idempotent and durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-work-request-"));
  const first = await createProjectWorkRequest({ root, projectId: "project-1", title: "Build profile", objective: "Implement profile", idempotencyKey: "profile-1", at, id: "work-1" });
  const second = await createProjectWorkRequest({ root, projectId: "project-1", title: "Build profile", objective: "Implement profile", idempotencyKey: "profile-1", at: "2026-09-20T12:01:00.000Z", id: "work-other" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.request.id, "work-1");
  assert.equal((await listProjectWorkRequests(root, "project-1")).length, 1);
  await assert.rejects(() => createProjectWorkRequest({ root, projectId: "project-1", title: "Different", objective: "Different", idempotencyKey: "profile-1", at }));
});

test("only one worker can claim a queued request and cancellation is durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-work-claim-"));
  await createProjectWorkRequest({ root, projectId: "project-1", title: "Build profile", objective: "Implement profile", idempotencyKey: "profile-1", at, id: "work-1" });
  const [first, second] = await Promise.all([
    claimProjectWorkRequest(root, "project-1", "work-1", at),
    claimProjectWorkRequest(root, "project-1", "work-1", at),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  const cancelled = await updateProjectWorkRequest(root, "project-1", "work-1", { status: "cancelled", blocker: "operator stopped" }, at);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal((await listProjectWorkRequests(root, "project-1"))[0]?.attempts, 1);
});

test("execution waits for dependencies and connects exactly one durable Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-work-execute-"));
  await createProjectWorkRequest({ root, projectId: "project-1", title: "Base", objective: "Base work", idempotencyKey: "base", at, id: "base" });
  await createProjectWorkRequest({ root, projectId: "project-1", title: "Follow up", objective: "Follow-up work", idempotencyKey: "follow", dependencies: ["base"], at, id: "follow" });
  const waiting = await executeProjectWorkRequest({ root, projectId: "project-1", id: "follow", at, execute: async () => ({ runId: "run-never", status: "created" }) });
  assert.equal(waiting.status, "waiting");
  assert.match(waiting.blocker ?? "", /dependencies incomplete/);
  await updateProjectWorkRequest(root, "project-1", "base", { status: "completed" }, at);
  let executions = 0;
  const started = await executeProjectWorkRequest({ root, projectId: "project-1", id: "follow", at, execute: async () => {
    executions += 1;
    return { runId: "run-follow", status: "created" as const };
  } });
  assert.equal(started.status, "started");
  assert.equal(started.runId, "run-follow");
  assert.equal(executions, 1);
  const duplicate = await executeProjectWorkRequest({ root, projectId: "project-1", id: "follow", at, execute: async () => {
    executions += 1;
    return { runId: "run-duplicate", status: "created" as const };
  } });
  assert.equal(duplicate.status, "in-progress");
  assert.equal(executions, 1);
});

test("a claim without a Run remains non-retryable after a worker crash", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-work-crash-"));
  await createProjectWorkRequest({ root, projectId: "project-1", title: "Crash", objective: "Crash boundary", idempotencyKey: "crash", at, id: "crash" });
  const claimed = await claimProjectWorkRequest(root, "project-1", "crash", at);
  assert.equal(claimed?.status, "running");
  const recovered = await executeProjectWorkRequest({ root, projectId: "project-1", id: "crash", at, execute: async () => ({ runId: "run-unsafe", status: "created" as const }) });
  assert.equal(recovered.status, "not-claimable");
  assert.match(recovered.blocker ?? "", /running/);
});

test("dependency creation rejects unknown work requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-work-dependency-"));
  await assert.rejects(() => createProjectWorkRequest({ root, projectId: "project-1", title: "Follow up", objective: "Follow-up", idempotencyKey: "follow", dependencies: ["missing"], at, id: "follow" }), /unknown work request dependency/);
});
