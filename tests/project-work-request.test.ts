import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimProjectWorkRequest,
  createProjectWorkRequest,
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
