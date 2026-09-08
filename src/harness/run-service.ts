import { stat } from "node:fs/promises";
import type {
  DevelopmentRunRequest,
  HarnessRuntimeRunEnvelope,
} from "./contracts.js";
import { prepareDevelopmentRun } from "./preflight.js";
import { loadHarnessRun, saveHarnessRun } from "./run-store.js";
import { createInitialRunState } from "./state-machine.js";

export type CreateDevelopmentRunOptions = {
  iseolRoot: string;
  storeRoot: string;
  loadedAt?: string;
  policyRoot?: string;
};

export async function createDevelopmentRun(
  request: DevelopmentRunRequest,
  options: CreateDevelopmentRunOptions,
): Promise<HarnessRuntimeRunEnvelope> {
  const preflight = await prepareDevelopmentRun(request, {
    iseolRoot: options.iseolRoot,
    loadedAt: options.loadedAt,
    policyRoot: options.policyRoot,
  });
  const now = options.loadedAt ?? new Date().toISOString();

  const envelope: HarnessRuntimeRunEnvelope = {
    version: 1,
    request,
    preflight,
    state: createInitialRunState(preflight, now),
    evidence: [],
    updatedAt: now,
  };

  await saveHarnessRun(options.storeRoot, envelope);
  return envelope;
}

export type RefreshDevelopmentRunPreflightOptions = {
  iseolRoot: string;
  storeRoot: string;
  runId: string;
  loadedAt?: string;
};

export async function refreshDevelopmentRunPreflight(
  options: RefreshDevelopmentRunPreflightOptions,
): Promise<HarnessRuntimeRunEnvelope> {
  const run = await loadHarnessRun(options.storeRoot, options.runId);
  if (!run) throw new Error(`Harness Run not found: ${options.runId}`);
  if (run.state.stage !== "CONTEXT" || run.state.status !== "READY") {
    throw new Error(`Harness preflight refresh requires READY CONTEXT, got ${run.state.status} ${run.state.stage}`);
  }
  const target = await stat(run.request.targetRoot);
  if (!target.isDirectory()) throw new Error(`Development Run targetRoot is not a directory: ${run.request.targetRoot}`);
  const at = options.loadedAt ?? new Date().toISOString();
  const preflight = await prepareDevelopmentRun(run.request, { iseolRoot: options.iseolRoot, loadedAt: at });
  const state: HarnessRuntimeRunEnvelope["state"] = preflight.status === "ready"
    ? { ...run.state, updatedAt: at }
    : { version: 1, stage: "PREFLIGHT", status: "BLOCKED_USER", completedStages: [], skippedStages: [], updatedAt: at, reason: preflight.reason ?? "Harness preflight refresh blocked" };
  const refreshed: HarnessRuntimeRunEnvelope = { ...run, preflight, state, updatedAt: at };
  await saveHarnessRun(options.storeRoot, refreshed);
  return refreshed;
}
