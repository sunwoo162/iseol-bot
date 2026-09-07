import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRuntimeRunEnvelope } from "../src/harness/contracts.js";
import type { DesktopJobResult, DesktopTaskPack } from "../src/desktop-agent/contracts.js";
import { registerDesktopAgent } from "../src/desktop-agent/agent-registry.js";
import { loadDesktopJob } from "../src/desktop-agent/job-store.js";
import { createDesktopStageExecutor } from "../src/desktop-agent/desktop-executor.js";

function run(targetRoot: string, stage: HarnessRuntimeRunEnvelope["state"]["stage"] = "TEST"): HarnessRuntimeRunEnvelope {
  return {
    version: 1,
    request: { version: 1, runId: "run-001", mode: "project-workspace", objective: "Test desktop bridge", targetRoot },
    preflight: { version: 1, runId: "run-001", status: "ready" },
    state: { version: 1, stage, status: "RUNNING", completedStages: ["PREFLIGHT"], skippedStages: [], updatedAt: "2026-09-08T03:00:00.000Z" },
    evidence: [],
    updatedAt: "2026-09-08T03:00:00.000Z",
  };
}

async function roots() {
  const base = await mkdtemp(join(tmpdir(), "iseol-desktop-executor-"));
  const targetRoot = join(base, "repo");
  await mkdir(targetRoot, { recursive: true });
  return { base, registryRoot: join(base, "registry"), jobRoot: join(base, "jobs"), targetRoot };
}

async function register(registryRoot: string, targetRoot: string) {
  await registerDesktopAgent(registryRoot, {
    version: 1,
    agentId: "agent-001",
    agentVersion: "0.1.0",
    os: "win32",
    capabilities: ["process", "git"],
    workspaceRoots: [targetRoot],
    token: "not-persisted",
  }, "2026-09-08T03:00:00.000Z");
}

function task(targetRoot: string, stage: DesktopTaskPack["stage"] = "TEST"): DesktopTaskPack {
  return {
    version: 1,
    jobId: `job-${stage.toLowerCase()}`,
    runId: "run-001",
    stage,
    attempt: 1,
    agentId: "agent-001",
    workspaceRoot: targetRoot,
    idempotencyKey: `${stage.toLowerCase()}:run-001`,
    leaseUntil: "2026-09-08T03:10:00.000Z",
    operations: [{ id: "op-1", type: "READ_FILE", path: "README.md" }],
  };
}

function completed(jobId = "job-test", status: DesktopJobResult["status"] = "completed"): DesktopJobResult {
  return {
    version: 1,
    jobId,
    runId: "run-001",
    agentId: "agent-001",
    status,
    completedAt: "2026-09-08T03:00:30.000Z",
    operations: [{ operationId: "op-1", ok: status === "completed", summary: status }],
  };
}

class FakeTransport {
  connected = true;
  sendCount = 0;
  nextResult: DesktopJobResult = completed();
  isAgentConnected() { return this.connected; }
  getAgentSessionId() { return this.connected ? "session-001" : null; }
  sendTask(_agentId: string, pack: DesktopTaskPack) {
    this.sendCount += 1;
    this.nextResult = { ...this.nextResult, jobId: pack.jobId, runId: pack.runId, agentId: pack.agentId };
  }
  async awaitResult() { return this.nextResult; }
}

test("offline agent returns waiting-agent and missing task intent waits for external planner", async () => {
  const { registryRoot, jobRoot, targetRoot } = await roots();
  const transport = new FakeTransport();
  const executor = createDesktopStageExecutor({
    registryRoot, jobRoot, transport,
    compileTaskPack: async () => task(targetRoot),
    now: () => "2026-09-08T03:00:10.000Z",
  });
  assert.equal((await executor.execute(run(targetRoot))).type, "waiting-agent");

  await register(registryRoot, targetRoot);
  const waiting = createDesktopStageExecutor({
    registryRoot, jobRoot, transport,
    compileTaskPack: async () => null,
    now: () => "2026-09-08T03:00:10.000Z",
  });
  assert.equal((await waiting.execute(run(targetRoot))).type, "waiting-external");
});

test("completed desktop job becomes stage evidence and duplicate execute reuses receipt", async () => {
  const { registryRoot, jobRoot, targetRoot } = await roots();
  await register(registryRoot, targetRoot);
  const transport = new FakeTransport();
  const executor = createDesktopStageExecutor({
    registryRoot, jobRoot, transport,
    compileTaskPack: async () => task(targetRoot),
    now: () => "2026-09-08T03:00:10.000Z",
  });

  const first = await executor.execute(run(targetRoot));
  assert.equal(first.type, "completed");
  if (first.type === "completed") {
    assert.equal(first.evidence[0]?.kind, "test");
    assert.equal(first.evidence[0]?.stage, "TEST");
    assert.match(first.evidence[0]?.reference ?? "", /desktop-job:job-test/);
  }
  const second = await executor.execute(run(targetRoot));
  assert.equal(second.type, "completed");
  assert.equal(transport.sendCount, 1);
});

test("retryable and protected desktop results map to Harness meanings", async () => {
  const { registryRoot, jobRoot, targetRoot } = await roots();
  await register(registryRoot, targetRoot);
  const retryTransport = new FakeTransport();
  retryTransport.nextResult = completed("job-test", "retryable-failure");
  const retryExecutor = createDesktopStageExecutor({
    registryRoot, jobRoot, transport: retryTransport,
    compileTaskPack: async () => task(targetRoot),
    now: () => "2026-09-08T03:00:10.000Z",
  });
  assert.equal((await retryExecutor.execute(run(targetRoot))).type, "retryable-failure");
  assert.equal((await loadDesktopJob(jobRoot, "job-test"))?.status, "pending");

  const blockedTransport = new FakeTransport();
  blockedTransport.nextResult = completed("job-test", "blocked-user");
  const blockedExecutor = createDesktopStageExecutor({
    registryRoot,
    jobRoot: join(jobRoot, "blocked"),
    transport: blockedTransport,
    compileTaskPack: async () => task(targetRoot),
    now: () => "2026-09-08T03:00:10.000Z",
  });
  assert.equal((await blockedExecutor.execute(run(targetRoot))).type, "blocked-user");
});
