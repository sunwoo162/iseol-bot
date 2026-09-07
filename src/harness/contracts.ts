export const ISEOL_HARNESS_CONTRACT_VERSION = 1 as const;

export type DevelopmentRunMode = "idea-lab" | "project-workspace";

export type DevelopmentRunRequest = {
  version: 1;
  runId: string;
  mode: DevelopmentRunMode;
  objective: string;
  targetRoot: string;
};

export type HarnessPolicySource = {
  kind: "iseol-global" | "project-harness" | "project-agents";
  path: string;
  sha256: string;
  content: string;
};

export type HarnessPolicySnapshot = {
  version: 1;
  loadedAt: string;
  sources: HarnessPolicySource[];
  effectiveSha256: string;
};
export type HarnessPreflightRecord = {
  version: 1;
  runId: string;
  status: "ready" | "blocked";
  policy?: HarnessPolicySnapshot;
  reason?: string;
};

export type HarnessRunEnvelope = {
  version: 1;
  request: DevelopmentRunRequest;
  preflight: HarnessPreflightRecord;
  updatedAt: string;
};

export function assertHarnessContractVersion(version: number): asserts version is 1 {
  if (version !== ISEOL_HARNESS_CONTRACT_VERSION) {
    throw new Error(`Unsupported Iseol Harness contract version: ${version}`);
  }
}
