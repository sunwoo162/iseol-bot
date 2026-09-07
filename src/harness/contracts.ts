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

export type HarnessRunStage =
  | "PREFLIGHT" | "CONTEXT" | "ANALYZE" | "PLAN" | "IMPLEMENT"
  | "TEST" | "SELF_REVIEW" | "COMMIT" | "PR" | "CI" | "MERGE"
  | "DEPLOY" | "PRODUCTION_VERIFY" | "DONE";

export type HarnessRunStatus =
  | "READY" | "RUNNING" | "WAITING_EXTERNAL" | "WAITING_AGENT"
  | "RECOVERING" | "BLOCKED_USER" | "FAILED_RETRYABLE" | "FAILED_FINAL"
  | "PAUSED" | "CANCELLED" | "DONE";

export type HarnessSkippedStage = {
  stage: HarnessRunStage;
  reason: string;
  at: string;
};

export type HarnessRunState = {
  version: 1;
  stage: HarnessRunStage;
  status: HarnessRunStatus;
  completedStages: HarnessRunStage[];
  skippedStages: HarnessSkippedStage[];
  updatedAt: string;
  reason?: string;
};

export type HarnessEvidenceKind =
  | "command" | "build" | "file-change" | "test" | "review"
  | "commit" | "pull-request" | "ci" | "deployment" | "production-verification";

export type HarnessEvidenceRecord = {
  version: 1;
  id: string;
  kind: HarnessEvidenceKind;
  stage: HarnessRunStage;
  recordedAt: string;
  summary: string;
  provider?: string;
  reference?: string;
};

export type HarnessRunEnvelope = {
  version: 1;
  request: DevelopmentRunRequest;
  preflight: HarnessPreflightRecord;
  state?: HarnessRunState;
  evidence?: HarnessEvidenceRecord[];
  updatedAt: string;
};

export function assertHarnessContractVersion(version: number): asserts version is 1 {
  if (version !== ISEOL_HARNESS_CONTRACT_VERSION) {
    throw new Error(`Unsupported Iseol Harness contract version: ${version}`);
  }
}
