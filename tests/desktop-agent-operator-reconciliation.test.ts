import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DesktopTaskPack } from "../src/desktop-agent/contracts.js";
import { createDesktopJob, desktopJobRevision, acquireDesktopJobLease } from "../src/desktop-agent/job-store.js";
import { consumeDesktopJobContainmentApproval, containDesktopJobAsOperator, inspectDesktopJobReconciliation, issueDesktopJobContainmentApproval, reconcileVerifiedDesktopJobResult } from "../src/desktop-agent/operator-reconciliation.js";
import { persistCompletedDesktopResult } from "../src/desktop-agent/result-store.js";

async function fixture(operation: DesktopTaskPack["operations"][number]) {
  const root = await mkdtemp(join(tmpdir(), "iseol-desktop-operator-"));
  const pack: DesktopTaskPack = {
    version: 1, jobId: "job-op-1", runId: "run-op-1", stage: "CONTEXT", attempt: 1,
    agentId: "agent-1", workspaceRoot: "C:/repo", idempotencyKey: "op:run-op-1",
    leaseUntil: "2026-09-20T01:10:00.000Z", operations: [operation],
    ...(operation.type === "GIT_INIT" ? { policyDigest: "a".repeat(64), policySources: [{ kind: "policy", path: "policy", sha256: "b".repeat(64), required: true }] } : {}),
  };
  const job = await createDesktopJob(root, pack, "2026-09-20T01:00:00.000Z");
  return { root, job };
}

test("operator containment requires target-bound single-use approval and keeps mutation uncertainty", async () => {
  const f = await fixture({ id: "init", type: "GIT_INIT", cwd: "." });
  const revision = desktopJobRevision(f.job);
  const approval = await issueDesktopJobContainmentApproval({ root: f.root, requestId: "request-1", jobId: f.job.jobId, runId: f.job.runId, revision, issuedAt: "2026-09-20T01:00:01.000Z", expiresAt: "2026-09-20T02:00:00.000Z", issuedBy: "operator" });
  const result = await containDesktopJobAsOperator({ root: f.root, jobId: f.job.jobId, expectedRevision: revision, operationId: "contain-op-1", approvalId: approval.approvalId, at: "2026-09-20T01:00:02.000Z", actor: "operator" });
  assert.equal(result.status, "contained");
  assert.equal(result.containment.mutationRisk, "mutation-uncertain");
  assert.equal(result.inspection.canContain, false);
  assert.equal(result.inspection.status, "pending");
  assert.equal((await inspectDesktopJobReconciliation({ root: f.root, jobId: f.job.jobId, now: "2026-09-20T01:00:03.000Z" }))?.contained, true);
});

test("operator containment rejects stale revisions and active leases", async () => {
  const f = await fixture({ id: "inspect", type: "GIT_INSPECT", cwd: "." });
  const approval = await issueDesktopJobContainmentApproval({ root: f.root, requestId: "request-2", jobId: f.job.jobId, runId: f.job.runId, revision: desktopJobRevision(f.job), issuedAt: "2026-09-20T01:00:01.000Z", expiresAt: "2026-09-20T02:00:00.000Z", issuedBy: "operator" });
  const stale = await containDesktopJobAsOperator({ root: f.root, jobId: f.job.jobId, expectedRevision: "stale", operationId: "contain-op-2", approvalId: approval.approvalId, at: "2026-09-20T01:00:02.000Z", actor: "operator" });
  assert.equal(stale.status, "conflict");
  await acquireDesktopJobLease(f.root, f.job.jobId, "session", "2026-09-20T01:00:03.000Z", 60_000);
  const inspected = await inspectDesktopJobReconciliation({ root: f.root, jobId: f.job.jobId, now: "2026-09-20T01:00:04.000Z" });
  assert.deepEqual(inspected?.blockers, ["job-is-not-pending", "active-lease"]);
});

test("verified result reconciliation requires exact job, run, and agent identity", async () => {
  const f = await fixture({ id: "inspect", type: "GIT_INSPECT", cwd: "." });
  const resultRoot = join(f.root, "results");
  await persistCompletedDesktopResult(resultRoot, { version: 1, jobId: f.job.jobId, runId: f.job.runId, agentId: f.job.pack.agentId, status: "completed", completedAt: "2026-09-20T01:00:05.000Z", operations: [{ operationId: "inspect", ok: true, summary: "verified" }] });
  const reconciled = await reconcileVerifiedDesktopJobResult({ jobRoot: f.root, resultRoot, jobId: f.job.jobId, now: "2026-09-20T01:00:06.000Z" });
  assert.equal(reconciled.status, "reconciled");
  const duplicate = await reconcileVerifiedDesktopJobResult({ jobRoot: f.root, resultRoot, jobId: f.job.jobId, now: "2026-09-20T01:00:07.000Z" });
  assert.equal(duplicate.status, "already-reconciled");
});

test("verified result from another Run is rejected without changing the pending job", async () => {
  const f = await fixture({ id: "inspect", type: "GIT_INSPECT", cwd: "." });
  const resultRoot = join(f.root, "wrong-results");
  await persistCompletedDesktopResult(resultRoot, { version: 1, jobId: f.job.jobId, runId: "other-run", agentId: f.job.pack.agentId, status: "completed", completedAt: "2026-09-20T01:00:05.000Z", operations: [{ operationId: "inspect", ok: true, summary: "wrong" }] });
  const result = await reconcileVerifiedDesktopJobResult({ jobRoot: f.root, resultRoot, jobId: f.job.jobId, now: "2026-09-20T01:00:06.000Z" });
  assert.deepEqual(result, { status: "not-matching", reason: "result-identity-mismatch" });
});

test("desktop operator containment approval issuance is serialized across service instances", async () => {
  const f = await fixture({ id: "inspect", type: "GIT_INSPECT", cwd: "." });
  const revision = desktopJobRevision(f.job);
  const instances = await Promise.all(
    Array.from({ length: 8 }, (_, index) => import(`../src/desktop-agent/operator-reconciliation.ts?desktop-approval-instance=${index}`)),
  );
  const attempts = await Promise.allSettled(instances.map((service, index) => service.issueDesktopJobContainmentApproval({
    root: f.root,
    requestId: "cross-service-desktop-request",
    jobId: f.job.jobId,
    runId: f.job.runId,
    revision,
    issuedAt: "2026-09-20T01:00:01.000Z",
    expiresAt: "2026-09-20T02:00:00.000Z",
    issuedBy: `operator-${index}`,
  })));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 7);
});

test("desktop operator containment consumes one approval across service instances", async () => {
  const f = await fixture({ id: "init", type: "GIT_INIT", cwd: "." });
  const revision = desktopJobRevision(f.job);
  const approval = await issueDesktopJobContainmentApproval({
    root: f.root,
    requestId: "cross-service-desktop-consume-request",
    jobId: f.job.jobId,
    runId: f.job.runId,
    revision,
    issuedAt: "2026-09-20T01:00:01.000Z",
    expiresAt: "2026-09-20T02:00:00.000Z",
    issuedBy: "operator",
  });
  const instances = await Promise.all(
    Array.from({ length: 8 }, (_, index) => import(`../src/desktop-agent/operator-reconciliation.ts?desktop-consume-instance=${index}`)),
  );
  const attempts = await Promise.allSettled(instances.map((service) => service.consumeDesktopJobContainmentApproval({
    root: f.root,
    jobId: f.job.jobId,
    runId: f.job.runId,
    revision,
    approvalId: approval.approvalId,
    at: "2026-09-20T01:00:02.000Z",
  })));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 8);
  assert.equal(attempts.filter((attempt): attempt is PromiseFulfilledResult<{ ok: true }> => attempt.status === "fulfilled" && attempt.value.ok).length, 1);
  assert.equal(attempts.filter((attempt): attempt is PromiseFulfilledResult<{ ok: false; reason: string }> => attempt.status === "fulfilled" && !attempt.value.ok && attempt.value.reason === "approval-already-consumed").length, 7);
});

test("desktop operator containment converges on one record across service instances", async () => {
  const f = await fixture({ id: "init", type: "GIT_INIT", cwd: "." });
  const revision = desktopJobRevision(f.job);
  const approvals = await Promise.all(Array.from({ length: 8 }, (_, index) => issueDesktopJobContainmentApproval({
    root: f.root,
    requestId: `cross-service-desktop-job-request-${index}`,
    jobId: f.job.jobId,
    runId: f.job.runId,
    revision,
    issuedAt: "2026-09-20T01:00:01.000Z",
    expiresAt: "2026-09-20T02:00:00.000Z",
    issuedBy: "operator",
  })));
  const instances = await Promise.all(
    Array.from({ length: 8 }, (_, index) => import(`../src/desktop-agent/operator-reconciliation.ts?desktop-job-instance=${index}`)),
  );
  const attempts = await Promise.allSettled(instances.map((service, index) => service.containDesktopJobAsOperator({
    root: f.root,
    jobId: f.job.jobId,
    expectedRevision: revision,
    operationId: "cross-service-desktop-job-containment",
    approvalId: approvals[index]!.approvalId,
    at: "2026-09-20T01:00:02.000Z",
    actor: "operator",
  })));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 8);
  assert.equal(attempts.filter((attempt): attempt is PromiseFulfilledResult<{ status: "contained" }> => attempt.status === "fulfilled" && attempt.value.status === "contained").length, 1);
  assert.equal(attempts.filter((attempt): attempt is PromiseFulfilledResult<{ status: "already-contained" }> => attempt.status === "fulfilled" && attempt.value.status === "already-contained").length, 7);
});

test("verified Desktop result reconciliation is single-winner across service instances", async () => {
  const f = await fixture({ id: "inspect", type: "GIT_INSPECT", cwd: "." });
  const resultRoot = join(f.root, "results");
  await persistCompletedDesktopResult(resultRoot, {
    version: 1,
    jobId: f.job.jobId,
    runId: f.job.runId,
    agentId: f.job.pack.agentId,
    status: "completed",
    completedAt: "2026-09-20T01:00:05.000Z",
    operations: [{ operationId: "inspect", ok: true, summary: "verified" }],
  });
  const instances = await Promise.all(
    Array.from({ length: 8 }, (_, index) => import(`../src/desktop-agent/operator-reconciliation.ts?desktop-result-instance=${index}`)),
  );
  const attempts = await Promise.allSettled(instances.map((service) => service.reconcileVerifiedDesktopJobResult({
    jobRoot: f.root,
    resultRoot,
    jobId: f.job.jobId,
    now: "2026-09-20T01:00:06.000Z",
  })));
  assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 8);
  assert.equal(attempts.filter((attempt): attempt is PromiseFulfilledResult<{ status: "reconciled" }> => attempt.status === "fulfilled" && attempt.value.status === "reconciled").length, 1);
  assert.equal(attempts.filter((attempt): attempt is PromiseFulfilledResult<{ status: "already-reconciled" }> => attempt.status === "fulfilled" && attempt.value.status === "already-reconciled").length, 7);
});
