import type {
  DevelopmentRunRequest,
  HarnessRuntimeRunEnvelope,
} from "./contracts.js";
import { prepareDevelopmentRun } from "./preflight.js";
import { saveHarnessRun } from "./run-store.js";
import { createInitialRunState } from "./state-machine.js";

export type CreateDevelopmentRunOptions = {
  iseolRoot: string;
  storeRoot: string;
  loadedAt?: string;
};

export async function createDevelopmentRun(
  request: DevelopmentRunRequest,
  options: CreateDevelopmentRunOptions,
): Promise<HarnessRuntimeRunEnvelope> {
  const preflight = await prepareDevelopmentRun(request, {
    iseolRoot: options.iseolRoot,
    loadedAt: options.loadedAt,
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
