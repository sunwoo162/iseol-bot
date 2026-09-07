import type {
  DevelopmentRunRequest,
  HarnessRunEnvelope,
} from "./contracts.js";
import { prepareDevelopmentRun } from "./preflight.js";
import { saveHarnessRun } from "./run-store.js";

export type CreateDevelopmentRunOptions = {
  iseolRoot: string;
  storeRoot: string;
  loadedAt?: string;
};

export async function createDevelopmentRun(
  request: DevelopmentRunRequest,
  options: CreateDevelopmentRunOptions,
): Promise<HarnessRunEnvelope> {
  const preflight = await prepareDevelopmentRun(request, {
    iseolRoot: options.iseolRoot,
    loadedAt: options.loadedAt,
  });

  const envelope: HarnessRunEnvelope = {
    version: 1,
    request,
    preflight,
    updatedAt: options.loadedAt ?? new Date().toISOString(),
  };

  await saveHarnessRun(options.storeRoot, envelope);
  return envelope;
}
