import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireRuntimeLock, acquireRuntimeMaintenanceLock, loadRuntimeHostConfig, saveRuntimeHostConfig } from "../scripts/iseol-runtime-host.js";
import { approveAndContainRuntimeMaintenanceJob, containRuntimeMaintenanceJob } from "../scripts/iseol-runtime-host.js";
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

test("runtime host reclaims a lock only after its recorded owner exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-host-stale-"));
  const path = join(root, "runtime.lock");
  await writeFile(path, JSON.stringify({ version: 1, pid: 999999, startedAt: "2026-01-01T00:00:00.000Z" }));
  const release = await acquireRuntimeLock(path);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pid, process.pid);
  await release();
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
