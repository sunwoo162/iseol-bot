import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HarnessEvidenceRecord,
  HarnessRuntimeRunEnvelope,
  HarnessRunStage,
} from "../src/harness/contracts.js";
import { loadLatestHarnessCheckpoint, loadHarnessRunEvents } from "../src/harness/event-store.js";
import { loadHarnessRun, saveHarnessRun } from "../src/harness/run-store.js";
import {
  superviseHarnessRun,
  type HarnessStageExecutor,
} from "../src/harness/run-supervisor.js";

function runtimeRun(
  stage: HarnessRunStage = "CONTEXT",
  evidence: HarnessEvidenceRecord[] = [],
): HarnessRuntimeRunEnvelope {
  return {
    version: 1,
    request: {
      version: 1,
      runId: "run-001",
      mode: "project-workspace",
      objective: "Autonomously continue the Run",
      targetRoot: "C:/repo",
    },
    preflight: {
      version: 1,
      runId: "run-001",
      status: "ready",
      policy: {
        version: 1,
        loadedAt: "2026-09-07T00:00:00.000Z",
        sources: [],
        effectiveSha256: "a".repeat(64),
      },
    },
    state: {
      version: 1,
      stage,
      status: "READY",
      completedStages: ["PREFLIGHT"],
      skippedStages: [],
      updatedAt: "2026-09-07T00:00:01.000Z",
    },
    evidence,
    updatedAt: "2026-09-07T00:00:01.000Z",
  };
}

function evidence(
  kind: HarnessEvidenceRecord["kind"],
  stage: HarnessRunStage,
): HarnessEvidenceRecord {
  return {
    version: 1,
    id: `${stage}-${kind}`,
    kind,
    stage,
    recordedAt: "2026-09-07T00:00:02.000Z",
    summary: `${stage} ${kind}`,
  };
}

function clock() {
  let tick = 0;
  return () => `2026-09-07T00:00:${String(++tick).padStart(2, "0")}.000Z`;
}

test("supervisor advances multiple stages without user continue", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-supervisor-auto-"));
  await saveHarnessRun(root, runtimeRun());
  const calls: HarnessRunStage[] = [];
  const executor: HarnessStageExecutor = {
    execute: async (run) => {
      calls.push(run.state.stage);
      if (run.state.stage === "IMPLEMENT") {
        return { type: "waiting-external", reason: "preview build" };
      }
      return { type: "completed", evidence: [] };
    },
  };

  const result = await superviseHarnessRun({
    storeRoot: root,
    runId: "run-001",
    executor,
    maxSteps: 8,
    now: clock(),
  });
  assert.deepEqual(calls, ["CONTEXT", "ANALYZE", "PLAN", "IMPLEMENT"]);
  assert.equal(result.state.stage, "IMPLEMENT");
  assert.equal(result.state.status, "WAITING_EXTERNAL");
  assert.deepEqual(await loadHarnessRun(root, "run-001"), result);
});

test("blocking result stops immediately and persists state", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-supervisor-blocked-"));
  await saveHarnessRun(root, runtimeRun("ANALYZE"));
  let calls = 0;
  const executor: HarnessStageExecutor = {
    execute: async () => {
      calls += 1;
      return { type: "blocked-user", reason: "choose product direction" };
    },
  };

  const result = await superviseHarnessRun({
    storeRoot: root,
    runId: "run-001",
    executor,
    now: clock(),
  });

  assert.equal(calls, 1);
  assert.equal(result.state.status, "BLOCKED_USER");
  assert.equal(result.state.stage, "ANALYZE");
  assert.match(result.state.reason ?? "", /product direction/);
});
test("retryable failures are bounded by maxSteps", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-supervisor-retry-"));
  await saveHarnessRun(root, runtimeRun("IMPLEMENT"));
  let calls = 0;
  const executor: HarnessStageExecutor = {
    execute: async () => {
      calls += 1;
      return { type: "retryable-failure", reason: "transient worker failure" };
    },
  };

  const result = await superviseHarnessRun({
    storeRoot: root,
    runId: "run-001",
    executor,
    maxSteps: 3,
    now: clock(),
  });

  assert.equal(calls, 3);
  assert.equal(result.state.stage, "IMPLEMENT");
  assert.equal(result.state.status, "FAILED_RETRYABLE");
  assert.match(result.state.reason ?? "", /step budget/i);
});

test("DONE is rejected when full delivery evidence is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-supervisor-done-gate-"));
  await saveHarnessRun(root, runtimeRun("PRODUCTION_VERIFY"));
  const executor: HarnessStageExecutor = {
    execute: async () => ({
      type: "completed",
      evidence: [evidence("production-verification", "PRODUCTION_VERIFY")],
    }),
  };

  const result = await superviseHarnessRun({
    storeRoot: root,
    runId: "run-001",
    executor,
    maxSteps: 1,
    now: clock(),
  });

  assert.equal(result.state.stage, "PRODUCTION_VERIFY");
  assert.equal(result.state.status, "FAILED_FINAL");
  assert.match(result.state.reason ?? "", /completion.*evidence/i);
});

test("completed stage is checkpointed before the next executor call", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-supervisor-order-"));
  await saveHarnessRun(root, runtimeRun("CONTEXT"));
  let call = 0;
  const executor: HarnessStageExecutor = {
    execute: async (run) => {
      call += 1;
      if (call === 2) {
        const events = await loadHarnessRunEvents(root, "run-001");
        const checkpoint = await loadLatestHarnessCheckpoint(root, "run-001");
        assert.equal(events.some((item) => item.type === "stage-completed" && item.stage === "ANALYZE"), true);
        assert.equal(checkpoint?.state.stage, "ANALYZE");
      }
      if (run.state.stage === "ANALYZE") {
        return { type: "waiting-agent", reason: "worker handoff" };
      }
      return { type: "completed", evidence: [] };
    },
  };

  const result = await superviseHarnessRun({
    storeRoot: root,
    runId: "run-001",
    executor,
    maxSteps: 3,
    now: clock(),
  });

  assert.equal(call, 2);
  assert.equal(result.state.status, "WAITING_AGENT");
});
