import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRuntimeLock, acquireRuntimeMaintenanceLock, acquireRuntimeRecoveryLock, inspectRuntimeLock, loadRuntimeHostConfig, recoverStaleRuntimeLock, recoverStaleRuntimeLockAndContainRuntimeMaintenanceJobs, runtimeRecoveryLockPath, runtimeStopSignal, saveRuntimeHostConfig } from "../scripts/iseol-runtime-host.js";
import { approveAndContainRuntimeMaintenanceJob, approveAndContainRuntimeMaintenanceJobs, containRuntimeMaintenanceJob } from "../scripts/iseol-runtime-host.js";
import { saveHarnessRun } from "../src/harness/run-store.js";
import { createDesktopJob, desktopJobRevision, loadDesktopJob, loadDesktopJobContainment } from "../src/desktop-agent/job-store.js";
import { issueDesktopJobContainmentApproval } from "../src/desktop-agent/operator-reconciliation.js";
import type { HarnessRuntimeRunEnvelope } from "../src/harness/contracts.js";
import type { DesktopTaskPack } from "../src/desktop-agent/contracts.js";

test("runtime host loads explicit roots and derives a durable lock path", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-"));
  const file = join(root, "runtime.json");
  await writeFile(file, JSON.stringify({ dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"), webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile") }));
  const config = loadRuntimeHostConfig(file);
  assert.equal(config.dataRoot, root);
  assert.equal(config.lockPath, join(root, "runtime", "iseol-runtime.lock"));
  assert.equal(config.version, 1);
});

test("runtime stop uses a catchable signal on Windows and SIGTERM elsewhere", () => {
  assert.equal(runtimeStopSignal("win32"), "SIGINT");
  assert.equal(runtimeStopSignal("linux"), "SIGTERM");
});

test("runtime host persists bounded lifecycle metadata atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-config-"));
  const file = join(root, "runtime.json");
  await saveRuntimeHostConfig(file, {
    dataRoot: root,
    modelRoot: join(root, "model"),
    runRoot: join(root, "runs"),
    webWorkerRoot: join(root, "workers"),
    browserProfileRoot: join(root, "profile"),
    lockPath: join(root, "runtime", "lock"),
    codeVersion: "abc123",
    projectRuntimeEnabled: true,
    desktopAgentId: "agent-project",
    projectModelRoot: join(root, "project-model"),
    projectRunRoot: join(root, "project-runs"),
    projectWebWorkerRoot: join(root, "project-workers"),
    projectDesktopStateRoot: join(root, "project-desktop"),
  });
  const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(saved.version, 1);
  assert.equal(saved.codeVersion, "abc123");
  assert.equal(saved.projectRuntimeEnabled, true);
  assert.equal(saved.desktopAgentId, "agent-project");
  assert.equal(saved.projectRunRoot, join(root, "project-runs"));
  assert.equal("token" in saved, false);
  assert.equal(loadRuntimeHostConfig(file).projectRuntimeEnabled, true);
  assert.equal(loadRuntimeHostConfig(file).projectDesktopStateRoot, join(root, "project-desktop"));
});

test("runtime host rejects invalid project lifecycle metadata before startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-invalid-"));
  const file = join(root, "runtime.json");
  await writeFile(file, JSON.stringify({ dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"), webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile"), projectRuntimeEnabled: "yes" }));
  assert.throws(() => loadRuntimeHostConfig(file), /projectRuntimeEnabled/);
});

test("runtime host rejects project roots that overlap Idea Lab roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-overlap-"));
  const file = join(root, "runtime.json");
  await writeFile(file, JSON.stringify({
    dataRoot: root,
    modelRoot: join(root, "model"),
    runRoot: join(root, "runs"),
    webWorkerRoot: join(root, "workers"),
    browserProfileRoot: join(root, "profile"),
    projectModelRoot: join(root, "model"),
    projectRunRoot: join(root, "project-runs"),
    projectWebWorkerRoot: join(root, "project-workers"),
    projectDesktopStateRoot: join(root, "project-desktop"),
  }));
  assert.throws(() => loadRuntimeHostConfig(file), /project.*overlap/i);
});

test("runtime host lock prevents concurrent ownership and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-lock-"));
  const path = join(root, "runtime.lock");
  const release = await acquireRuntimeLock(path);
  await assert.rejects(acquireRuntimeLock(path), /already owns/);
  await release();
  const releaseAgain = await acquireRuntimeLock(path);
  await releaseAgain();
});

test("runtime host refuses implicit stale lock takeover and requires explicit recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-stale-"));
  const path = join(root, "runtime.lock");
  await writeFile(path, JSON.stringify({ version: 1, pid: 999999, startedAt: "2026-01-01T00:00:00.000Z" }));
  await assert.rejects(acquireRuntimeLock(path), /explicit operator recovery/i);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pid, 999999);
});

test("runtime lock inspection distinguishes verified owner, stale identity, and legacy owner uncertainty", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-inspect-"));
  const path = join(root, "runtime.lock");
  await writeFile(path, JSON.stringify({ version: 1, pid: 42, ownerIdentity: "owner-a", startedAt: "2026-01-01T00:00:00.000Z" }));
  const stale = await inspectRuntimeLock(path, async () => ({ state: "absent" as const }));
  assert.equal(stale.state, "stale");
  assert.equal(stale.identity.ownerIdentity, "owner-a");
  await writeFile(path, JSON.stringify({ version: 1, pid: 42, startedAt: "2026-01-01T00:00:00.000Z" }));
  const legacy = await inspectRuntimeLock(path, async () => ({ state: "absent" as const }));
  assert.equal(legacy.state, "owner-unconfirmed");
});

test("stale lock recovery requires the exact fingerprint, operator approval, and recovery ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-recovery-"));
  const lockPath = join(root, "runtime.lock");
  await writeFile(lockPath, JSON.stringify({ version: 1, pid: 42, ownerIdentity: "owner-a", startedAt: "2026-01-01T00:00:00.000Z" }));
  const inspection = await inspectRuntimeLock(lockPath, async () => ({ state: "absent" as const }));
  const config = { version: 1 as const, dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"), webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile"), lockPath };
  const rejected = await recoverStaleRuntimeLock(config, {
    expectedFingerprint: "wrong", operatorToken: "secret", configuredOperatorToken: "secret", operatorId: "operator",
    confirmation: `I approve stale Runtime lock recovery for ${inspection.fingerprint}`, at: "2026-01-01T01:00:00.000Z",
    probe: async () => ({ state: "absent" as const }),
  });
  assert.equal(rejected.status, "rejected");
  const recovered = await recoverStaleRuntimeLock(config, {
    expectedFingerprint: inspection.fingerprint, operatorToken: "secret", configuredOperatorToken: "secret", operatorId: "operator",
    confirmation: `I approve stale Runtime lock recovery for ${inspection.fingerprint}`, at: "2026-01-01T01:00:00.000Z",
    probe: async () => ({ state: "absent" as const }),
  });
  assert.equal(recovered.status, "recovered");
  assert.equal((await inspectRuntimeLock(lockPath, async () => ({ state: "absent" as const }))).state, "stopped");
  await assert.rejects(acquireRuntimeLock(lockPath), /maintenance.*active/i);
  await recovered.releaseMaintenance();
});

test("stale recovery fails closed when the owner identity cannot be verified or the lock changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-recovery-guard-"));
  const lockPath = join(root, "runtime.lock");
  await writeFile(lockPath, JSON.stringify({ version: 1, pid: 42, ownerIdentity: "owner-a", startedAt: "2026-01-01T00:00:00.000Z" }));
  const config = { version: 1 as const, dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"), webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile"), lockPath };
  const inspection = await inspectRuntimeLock(lockPath, async () => ({ state: "unavailable" as const }));
  assert.equal(inspection.state, "owner-unconfirmed");
  const denied = await recoverStaleRuntimeLock(config, {
    expectedFingerprint: inspection.fingerprint, operatorToken: "secret", configuredOperatorToken: "secret", operatorId: "operator",
    confirmation: `I approve stale Runtime lock recovery for ${inspection.fingerprint}`, at: "2026-01-01T01:00:00.000Z",
    probe: async () => ({ state: "unavailable" as const }),
  });
  assert.equal(denied.status, "rejected");
  await writeFile(lockPath, JSON.stringify({ version: 1, pid: 43, ownerIdentity: "owner-b", startedAt: "2026-01-01T00:00:00.000Z" }));
  const changed = await recoverStaleRuntimeLock(config, {
    expectedFingerprint: inspection.fingerprint, operatorToken: "secret", configuredOperatorToken: "secret", operatorId: "operator",
    confirmation: `I approve stale Runtime lock recovery for ${inspection.fingerprint}`, at: "2026-01-01T01:00:00.000Z",
    probe: async () => ({ state: "absent" as const }),
  });
  assert.equal(changed.status, "rejected");
});

test("recovery ownership blocks Runtime startup and maintenance ownership in both directions", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-recovery-race-"));
  const runtimePath = join(root, "runtime.lock");
  const recoveryPath = runtimeRecoveryLockPath(runtimePath);
  const recoveryRelease = await acquireRuntimeRecoveryLock(runtimePath, recoveryPath);
  await assert.rejects(acquireRuntimeLock(runtimePath), /recovery ownership/i);
  await assert.rejects(acquireRuntimeMaintenanceLock(runtimePath), /recovery ownership/i);
  await recoveryRelease();
  const maintenanceRelease = await acquireRuntimeMaintenanceLock(runtimePath);
  await assert.rejects(acquireRuntimeRecoveryLock(runtimePath, recoveryPath), /maintenance ownership/i);
  await maintenanceRelease();
});

test("stale recovery and maintenance handoff are one ownership transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-recovery-handoff-"));
  const lockPath = join(root, "runtime.lock");
  await writeFile(lockPath, JSON.stringify({ version: 1, pid: 42, ownerIdentity: "owner-a", startedAt: "2026-01-01T00:00:00.000Z" }));
  const inspection = await inspectRuntimeLock(lockPath, async () => ({ state: "absent" as const }));
  const config = { version: 1 as const, dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"), webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile"), lockPath, projectRunRoot: join(root, "project-runs"), projectDesktopStateRoot: join(root, "project-desktop") };
  const result = await recoverStaleRuntimeLockAndContainRuntimeMaintenanceJobs(config, {
    expectedFingerprint: inspection.fingerprint,
    recoveryConfirmation: `I approve stale Runtime lock recovery for ${inspection.fingerprint}`,
    operatorToken: "secret", configuredOperatorToken: "secret", operatorId: "operator", at: "2026-01-01T01:00:00.000Z",
    jobs: [], probe: async () => ({ state: "absent" as const }),
  });
  assert.equal(result.recovery, "recovered");
  assert.equal(result.maintenance?.status, "rejected");
  assert.equal((await inspectRuntimeLock(lockPath, async () => ({ state: "absent" as const }))).state, "stopped");
  assert.equal((await readFile(join(root, "iseol-maintenance.lock"), "utf8").catch(() => null)), null);
});

test("maintenance ownership cannot overlap a live Runtime and blocks Runtime takeover", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-maintenance-"));
  const runtimePath = join(root, "runtime.lock");
  const maintenancePath = join(root, "iseol-maintenance.lock");
  const runtimeRelease = await acquireRuntimeLock(runtimePath);
  await assert.rejects(acquireRuntimeMaintenanceLock(runtimePath, maintenancePath), /runtime.*active/i);
  await runtimeRelease();
  const maintenanceRelease = await acquireRuntimeMaintenanceLock(runtimePath, maintenancePath);
  await assert.rejects(acquireRuntimeLock(runtimePath), /maintenance.*active/i);
  await maintenanceRelease();
  const nextRuntimeRelease = await acquireRuntimeLock(runtimePath);
  await nextRuntimeRelease();
});

test("stale maintenance ownership is preserved instead of being force-removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-maintenance-stale-"));
  const runtimePath = join(root, "runtime.lock");
  const maintenancePath = join(root, "iseol-maintenance.lock");
  await writeFile(maintenancePath, JSON.stringify({ version: 1, pid: 999999 }));
  await assert.rejects(acquireRuntimeMaintenanceLock(runtimePath, maintenancePath), /maintenance.*already exists/i);
  assert.equal(JSON.parse(await readFile(maintenancePath, "utf8")).pid, 999999);
});

test("maintenance containment owns the stopped Runtime window and preserves the original job", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-maintenance-action-"));
  const config = {
    version: 1 as const, dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"),
    webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile"), lockPath: join(root, "runtime", "iseol-runtime.lock"),
    projectRunRoot: join(root, "project-runs"), projectDesktopStateRoot: join(root, "project-desktop"),
  };
  const run: HarnessRuntimeRunEnvelope = {
    version: 1, request: { version: 1, mode: "project-workspace", runId: "run-maint", projectId: "project-a", objective: "inspect", targetRoot: join(root, "workspace") },
    preflight: { version: 1, runId: "run-maint", status: "ready" },
    state: { version: 1, stage: "CONTEXT", status: "FAILED_RETRYABLE", completedStages: ["PREFLIGHT"], skippedStages: [], updatedAt: "2026-09-20T02:00:00.000Z" },
    evidence: [], updatedAt: "2026-09-20T02:00:00.000Z",
  };
  await saveHarnessRun(config.projectRunRoot, run);
  const pack: DesktopTaskPack = {
    version: 1, jobId: "job-maint", runId: "run-maint", stage: "CONTEXT", attempt: 1, agentId: "agent-live", workspaceRoot: run.request.targetRoot,
    idempotencyKey: "maint:run-maint", leaseUntil: "2026-09-20T02:10:00.000Z", operations: [{ id: "init", type: "GIT_INIT", cwd: "." }],
    policyDigest: "a".repeat(64), policySources: [{ kind: "policy", path: "policy", sha256: "b".repeat(64), required: true }],
  };
  const job = await createDesktopJob(config.projectDesktopStateRoot, pack, "2026-09-20T02:00:00.000Z");
  const revision = desktopJobRevision(job);
  const approval = await issueDesktopJobContainmentApproval({ root: config.projectDesktopStateRoot, requestId: "maint-request", jobId: job.jobId, runId: job.runId, revision, issuedAt: "2026-09-20T02:00:01.000Z", expiresAt: "2026-09-20T03:00:00.000Z", issuedBy: "operator" });
  const result = await containRuntimeMaintenanceJob(config, { projectId: "project-a", jobId: job.jobId, expectedRevision: revision, operationId: "maint-op", approvalId: approval.approvalId, at: "2026-09-20T02:00:02.000Z" });
  assert.equal(result.status, "contained");
  assert.equal((await loadDesktopJob(config.projectDesktopStateRoot, job.jobId))?.status, "pending");
  assert.equal((await loadDesktopJobContainment(config.projectDesktopStateRoot, job.jobId))?.mutationRisk, "mutation-uncertain");
});

test("maintenance approval requires authenticated explicit confirmation and contains atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-maintenance-approval-"));
  const config = {
    version: 1 as const, dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"),
    webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile"), lockPath: join(root, "runtime", "iseol-runtime.lock"),
    projectRunRoot: join(root, "project-runs"), projectDesktopStateRoot: join(root, "project-desktop"),
  };
  const run: HarnessRuntimeRunEnvelope = {
    version: 1, request: { version: 1, mode: "project-workspace", runId: "run-approval", projectId: "project-a", objective: "inspect", targetRoot: join(root, "workspace") },
    preflight: { version: 1, runId: "run-approval", status: "ready" },
    state: { version: 1, stage: "CONTEXT", status: "FAILED_RETRYABLE", completedStages: ["PREFLIGHT"], skippedStages: [], updatedAt: "2026-09-20T02:00:00.000Z" },
    evidence: [], updatedAt: "2026-09-20T02:00:00.000Z",
  };
  await saveHarnessRun(config.projectRunRoot, run);
  const pack: DesktopTaskPack = {
    version: 1, jobId: "job-approval", runId: "run-approval", stage: "CONTEXT", attempt: 1, agentId: "agent-live", workspaceRoot: run.request.targetRoot,
    idempotencyKey: "approval:run-approval", leaseUntil: "2026-09-20T02:10:00.000Z", operations: [{ id: "init", type: "GIT_INIT", cwd: "." }],
    policyDigest: "a".repeat(64), policySources: [{ kind: "policy", path: "policy", sha256: "b".repeat(64), required: true }],
  };
  const job = await createDesktopJob(config.projectDesktopStateRoot, pack, "2026-09-20T02:00:00.000Z");
  const revision = desktopJobRevision(job);
  const base = { projectId: "project-a", jobId: job.jobId, expectedRevision: revision, requestId: "approval-request", operationId: "approval-op", operatorId: "operator", at: "2026-09-20T02:00:02.000Z", expiresAt: "2026-09-20T03:00:00.000Z" };
  const unauthenticated = await approveAndContainRuntimeMaintenanceJob(config, { ...base, operatorToken: "wrong", configuredOperatorToken: "secret", confirmation: `I approve containment of ${job.jobId} at revision ${revision}` });
  assert.deepEqual(unauthenticated, { status: "rejected", reason: "operator-authentication-failed" });
  const unconfirmed = await approveAndContainRuntimeMaintenanceJob(config, { ...base, operatorToken: "secret", configuredOperatorToken: "secret", confirmation: "yes" });
  assert.equal(unconfirmed.status, "rejected");
  const approved = await approveAndContainRuntimeMaintenanceJob(config, { ...base, operatorToken: "secret", configuredOperatorToken: "secret", confirmation: `I approve containment of ${job.jobId} at revision ${revision}` });
  assert.equal(approved.status, "contained");
  if (approved.status === "contained") assert.ok(approved.approvalId);
  assert.equal((await loadDesktopJob(config.projectDesktopStateRoot, job.jobId))?.status, "pending");
  assert.equal((await loadDesktopJobContainment(config.projectDesktopStateRoot, job.jobId))?.mutationRisk, "mutation-uncertain");
});

test("multi-job maintenance containment keeps one ownership window while preserving independent approvals", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-maintenance-batch-"));
  const config = {
    version: 1 as const, dataRoot: root, modelRoot: join(root, "model"), runRoot: join(root, "runs"),
    webWorkerRoot: join(root, "workers"), browserProfileRoot: join(root, "profile"), lockPath: join(root, "runtime", "iseol-runtime.lock"),
    projectRunRoot: join(root, "project-runs"), projectDesktopStateRoot: join(root, "project-desktop"),
  };
  const makeRun = async (runId: string) => {
    const run: HarnessRuntimeRunEnvelope = {
      version: 1, request: { version: 1, mode: "project-workspace", runId, projectId: "project-a", objective: "inspect", targetRoot: join(root, "workspace", runId) },
      preflight: { version: 1, runId, status: "ready" },
      state: { version: 1, stage: "CONTEXT", status: "FAILED_RETRYABLE", completedStages: ["PREFLIGHT"], skippedStages: [], updatedAt: "2026-09-20T02:00:00.000Z" },
      evidence: [], updatedAt: "2026-09-20T02:00:00.000Z",
    };
    await saveHarnessRun(config.projectRunRoot, run);
  };
  await makeRun("run-batch-1");
  await makeRun("run-batch-2");
  const makeJob = async (jobId: string, runId: string, operation: DesktopTaskPack["operations"][number]["type"]) => createDesktopJob(config.projectDesktopStateRoot, {
    version: 1, jobId, runId, stage: "CONTEXT", attempt: 1, agentId: "agent-live", workspaceRoot: join(root, "workspace", runId),
    idempotencyKey: `batch:${jobId}`, leaseUntil: "2026-09-20T02:10:00.000Z", operations: [{ id: `${jobId}-op`, type: operation, cwd: "." }],
    policyDigest: "a".repeat(64), policySources: [{ kind: "policy", path: "policy", sha256: "b".repeat(64), required: true }],
  }, "2026-09-20T02:00:00.000Z");
  const job1 = await makeJob("job-batch-1", "run-batch-1", "GIT_INSPECT");
  const job2 = await makeJob("job-batch-2", "run-batch-2", "GIT_INIT");
  const revision1 = desktopJobRevision(job1);
  const revision2 = desktopJobRevision(job2);
  const result = await approveAndContainRuntimeMaintenanceJobs(config, {
    operatorToken: "secret", configuredOperatorToken: "secret", operatorId: "operator", at: "2026-09-20T02:00:02.000Z",
    jobs: [
      { projectId: "project-a", jobId: job1.jobId, expectedRevision: revision1, requestId: "batch-request-1", operationId: "batch-op-1", expiresAt: "2026-09-20T03:00:00.000Z", confirmation: `I approve containment of ${job1.jobId} at revision ${revision1}` },
      { projectId: "project-a", jobId: job2.jobId, expectedRevision: revision2, requestId: "batch-request-2", operationId: "batch-op-2", expiresAt: "2026-09-20T03:00:00.000Z", confirmation: "wrong confirmation" },
    ],
  });
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]?.status, "contained");
  assert.equal(result.results[1]?.status, "rejected");
  assert.equal((await loadDesktopJobContainment(config.projectDesktopStateRoot, job1.jobId))?.mutationRisk, "read-only-uncertain");
  assert.equal(await loadDesktopJobContainment(config.projectDesktopStateRoot, job2.jobId), null);
  assert.equal((await loadDesktopJob(config.projectDesktopStateRoot, job1.jobId))?.status, "pending");
  assert.equal((await loadDesktopJob(config.projectDesktopStateRoot, job2.jobId))?.status, "pending");
});
