import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopTaskPack } from "../src/desktop-agent/contracts.js";
import {
  acquireDesktopJobLease,
  completeDesktopJob,
  createDesktopJob,
  findDesktopJobByIdempotencyKey,
  listRecoverableDesktopJobs,
  loadDesktopJob,
  renewDesktopJobLease,
} from "../src/desktop-agent/job-store.js";

function pack(overrides: Partial<DesktopTaskPack> = {}): DesktopTaskPack {
  return {
    version: 1,
    jobId: "job-001",
    runId: "run-001",
    stage: "TEST",
    attempt: 1,
    agentId: "agent-001",
    workspaceRoot: "C:/repo",
    idempotencyKey: "test:run-001",
    leaseUntil: "2026-09-08T01:10:00.000Z",
    operations: [{ id: "op-1", type: "READ_FILE", path: "README.md" }],
    ...overrides,
  };
}

async function root() {
  return mkdtemp(join(tmpdir(), "iseol-desktop-job-"));
}

test("job creation is idempotent by semantic idempotency key", async () => {
  const store = await root();
  const first = await createDesktopJob(store, pack(), "2026-09-08T01:00:00.000Z");
  const second = await createDesktopJob(
    store,
    pack({ jobId: "job-retry", leaseUntil: "2026-09-08T01:20:00.000Z" }),
    "2026-09-08T01:01:00.000Z",
  );
  assert.equal(second.jobId, first.jobId);
  assert.equal((await findDesktopJobByIdempotencyKey(store, "test:run-001"))?.jobId, first.jobId);
  assert.deepEqual(await loadDesktopJob(store, first.jobId), first);
});

test("idempotency key rejects a conflicting payload", async () => {
  const store = await root();
  await createDesktopJob(store, pack(), "2026-09-08T01:00:00.000Z");
  await assert.rejects(
    createDesktopJob(
      store,
      pack({ operations: [{ id: "op-1", type: "READ_FILE", path: "OTHER.md" }] }),
      "2026-09-08T01:01:00.000Z",
    ),
    /idempotency.*conflict/i,
  );
});

test("leases are exclusive, renewable by owner, and transferable only after expiry", async () => {
  const store = await root();
  await createDesktopJob(store, pack(), "2026-09-08T01:00:00.000Z");
  const leased = await acquireDesktopJobLease(
    store, "job-001", "session-a", "2026-09-08T01:00:10.000Z", 60_000,
  );
  assert.equal(leased.lease?.owner, "session-a");
  assert.equal(leased.attempts, 1);

  await assert.rejects(
    acquireDesktopJobLease(store, "job-001", "session-b", "2026-09-08T01:00:20.000Z", 60_000),
    /active lease/i,
  );
  const renewed = await renewDesktopJobLease(
    store, "job-001", "session-a", "2026-09-08T01:00:30.000Z", 60_000,
  );
  assert.equal(renewed.lease?.owner, "session-a");

  await assert.rejects(
    renewDesktopJobLease(store, "job-001", "session-b", "2026-09-08T01:00:40.000Z", 60_000),
    /lease owner/i,
  );
  const takeover = await acquireDesktopJobLease(
    store, "job-001", "session-b", "2026-09-08T01:01:31.000Z", 60_000,
  );
  assert.equal(takeover.lease?.owner, "session-b");
  assert.equal(takeover.attempts, 2);
});

test("completed jobs are immutable", async () => {
  const store = await root();
  await createDesktopJob(store, pack(), "2026-09-08T01:00:00.000Z");
  await acquireDesktopJobLease(store, "job-001", "session-a", "2026-09-08T01:00:10.000Z", 60_000);
  const result = {
    version: 1 as const,
    jobId: "job-001",
    runId: "run-001",
    agentId: "agent-001",
    status: "completed" as const,
    completedAt: "2026-09-08T01:00:20.000Z",
    operations: [{ operationId: "op-1", ok: true, summary: "read" }],
  };
  const completed = await completeDesktopJob(store, "job-001", "session-a", result);
  assert.equal(completed.status, "completed");
  assert.deepEqual(await completeDesktopJob(store, "job-001", "session-a", result), completed);
  await assert.rejects(
    completeDesktopJob(store, "job-001", "session-a", { ...result, status: "final-failure" }),
    /completed job.*immutable/i,
  );
});

test("only unfinished jobs without a live lease are recoverable", async () => {
  const store = await root();
  await createDesktopJob(store, pack(), "2026-09-08T01:00:00.000Z");
  await acquireDesktopJobLease(store, "job-001", "session-a", "2026-09-08T01:00:00.000Z", 30_000);
  assert.deepEqual(
    (await listRecoverableDesktopJobs(store, "2026-09-08T01:01:00.000Z")).map((job) => job.jobId),
    ["job-001"],
  );
});
