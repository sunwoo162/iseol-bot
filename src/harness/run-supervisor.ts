import { randomUUID } from "node:crypto";
import type {
  HarnessEvidenceRecord,
  HarnessRuntimeRunEnvelope,
  HarnessRunStatus,
} from "./contracts.js";
import {
  assertRunCompletionEvidence,
  assertStageCompletionEvidence,
} from "./completion-gates.js";
import { appendHarnessRunEvent, saveHarnessCheckpoint } from "./event-store.js";
import { assertPreflightReady } from "./preflight.js";
import { loadHarnessRun, saveHarnessRun } from "./run-store.js";
import { nextHarnessStage, transitionRunState } from "./state-machine.js";

export type HarnessStageExecutionResult =
  | { type: "completed"; evidence: HarnessEvidenceRecord[] }
  | { type: "waiting-external"; reason: string }
  | { type: "waiting-agent"; reason: string }
  | { type: "blocked-user"; reason: string }
  | { type: "retryable-failure"; reason: string }
  | { type: "final-failure"; reason: string };

export interface HarnessStageExecutor {
  execute(run: HarnessRuntimeRunEnvelope): Promise<HarnessStageExecutionResult>;
}
export type SuperviseHarnessRunInput = {
  storeRoot: string;
  runId: string;
  executor: HarnessStageExecutor;
  maxSteps?: number;
  now?: () => string;
};

const STOP_STATUSES = new Set<HarnessRunStatus>([
  "WAITING_EXTERNAL",
  "WAITING_AGENT",
  "RECOVERING",
  "BLOCKED_USER",
  "FAILED_FINAL",
  "PAUSED",
  "CANCELLED",
  "DONE",
]);

function mergeEvidence(
  run: HarnessRuntimeRunEnvelope,
  incoming: HarnessEvidenceRecord[],
): HarnessEvidenceRecord[] {
  for (const item of incoming) {
    if (item.stage !== run.state.stage) {
      throw new Error(`Executor evidence stage mismatch: expected ${run.state.stage}, got ${item.stage}`);
    }
  }
  const byId = new Map(run.evidence.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}
async function persistRunTransition(
  storeRoot: string,
  run: HarnessRuntimeRunEnvelope,
  input: {
    at: string;
    type: "stage-started" | "stage-completed" | "status-changed";
    summary: string;
    evidenceIds?: string[];
  },
): Promise<void> {
  await saveHarnessRun(storeRoot, run);
  await appendHarnessRunEvent(storeRoot, {
    version: 1,
    id: randomUUID(),
    runId: run.request.runId,
    type: input.type,
    at: input.at,
    stage: run.state.stage,
    status: run.state.status,
    summary: input.summary,
    ...(input.evidenceIds === undefined ? {} : { evidenceIds: input.evidenceIds }),
  });
  await saveHarnessCheckpoint(storeRoot, {
    version: 1,
    id: randomUUID(),
    runId: run.request.runId,
    recordedAt: input.at,
    state: run.state,
    evidence: run.evidence,
    summary: input.summary,
  });
}

function updateRun(
  run: HarnessRuntimeRunEnvelope,
  state: HarnessRuntimeRunEnvelope["state"],
  at: string,
  evidence = run.evidence,
): HarnessRuntimeRunEnvelope {
  return { ...run, state, evidence, updatedAt: at };
}
function transitionForResult(
  run: HarnessRuntimeRunEnvelope,
  result: Exclude<HarnessStageExecutionResult, { type: "completed" | "retryable-failure" }>,
  at: string,
): HarnessRuntimeRunEnvelope {
  const transitionByType = {
    "waiting-external": "wait-external",
    "waiting-agent": "wait-agent",
    "blocked-user": "block-user",
    "final-failure": "final-failure",
  } as const;
  const transition = transitionByType[result.type];
  return updateRun(
    run,
    transitionRunState(run.state, {
      type: transition,
      at,
      reason: result.reason,
    }),
    at,
  );
}

async function startIfNeeded(
  storeRoot: string,
  run: HarnessRuntimeRunEnvelope,
  at: string,
): Promise<HarnessRuntimeRunEnvelope> {
  if (run.state.status !== "READY" && run.state.status !== "FAILED_RETRYABLE") return run;
  const started = updateRun(run, transitionRunState(run.state, { type: "start", at }), at);
  await persistRunTransition(storeRoot, started, {
    at,
    type: "stage-started",
    summary: `Started ${started.state.stage}`,
  });
  return started;
}
export async function superviseHarnessRun(
  input: SuperviseHarnessRunInput,
): Promise<HarnessRuntimeRunEnvelope> {
  const maxSteps = input.maxSteps ?? 64;
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
    throw new Error(`Harness Run maxSteps must be a positive integer: ${maxSteps}`);
  }
  const now = input.now ?? (() => new Date().toISOString());
  let run = await loadHarnessRun(input.storeRoot, input.runId);
  if (!run) throw new Error(`Harness Run not found: ${input.runId}`);
  assertPreflightReady(run.preflight);

  if (STOP_STATUSES.has(run.state.status)) return run;
  let steps = 0;

  while (steps < maxSteps) {
    run = await startIfNeeded(input.storeRoot, run, now());
    if (STOP_STATUSES.has(run.state.status)) return run;
    if (run.state.status !== "RUNNING") {
      throw new Error(`Harness Run is not executable from ${run.state.status}`);
    }

    const stage = run.state.stage;
    const result = await input.executor.execute(run);
    steps += 1;

    if (result.type === "completed") {
      const at = now();
      const combinedEvidence = mergeEvidence(run, result.evidence);
      try {
        assertStageCompletionEvidence(stage, combinedEvidence);
        if (nextHarnessStage(stage) === "DONE") {
          assertRunCompletionEvidence(combinedEvidence);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        run = updateRun(
          run,
          transitionRunState(run.state, { type: "final-failure", at, reason }),
          at,
          combinedEvidence,
        );
        await persistRunTransition(input.storeRoot, run, {
          at,
          type: "status-changed",
          summary: reason,
          evidenceIds: result.evidence.map((item) => item.id),
        });
        return run;
      }

      const completedStage = stage;
      run = updateRun(
        run,
        transitionRunState(run.state, { type: "complete-stage", at }),
        at,
        combinedEvidence,
      );
      await persistRunTransition(input.storeRoot, run, {
        at,
        type: "stage-completed",
        summary: `Completed ${completedStage}`,
        evidenceIds: result.evidence.map((item) => item.id),
      });
      if (run.state.status === "DONE") return run;
      continue;
    }
    const at = now();
    if (result.type === "retryable-failure") {
      const exhausted = steps >= maxSteps;
      const reason = exhausted
        ? `Step budget exhausted after ${steps} attempts: ${result.reason}`
        : result.reason;
      run = updateRun(
        run,
        transitionRunState(run.state, { type: "retryable-failure", at, reason }),
        at,
      );
      await persistRunTransition(input.storeRoot, run, {
        at,
        type: "status-changed",
        summary: reason,
      });
      if (exhausted) return run;
      continue;
    }

    run = transitionForResult(run, result, at);
    await persistRunTransition(input.storeRoot, run, {
      at,
      type: "status-changed",
      summary: result.reason,
    });
    return run;
  }

  const at = now();
  const reason = `Step budget exhausted after ${maxSteps} steps`;
  run = updateRun(
    run,
    transitionRunState(run.state, { type: "retryable-failure", at, reason }),
    at,
  );
  await persistRunTransition(input.storeRoot, run, {
    at,
    type: "status-changed",
    summary: reason,
  });
  return run;
}
