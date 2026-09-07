import type {
  HarnessEvidenceKind,
  HarnessEvidenceRecord,
  HarnessRunStage,
} from "./contracts.js";

const STAGE_EVIDENCE: Partial<Record<HarnessRunStage, HarnessEvidenceKind[]>> = {
  TEST: ["test"],
  SELF_REVIEW: ["review"],
  COMMIT: ["commit"],
  PR: ["pull-request"],
  CI: ["ci"],
  DEPLOY: ["deployment"],
  PRODUCTION_VERIFY: ["production-verification"],
};

const DEFAULT_DELIVERY_STAGES: HarnessRunStage[] = [
  "TEST",
  "SELF_REVIEW",
  "COMMIT",
  "PR",
  "CI",
  "DEPLOY",
  "PRODUCTION_VERIFY",
];

export function requiredEvidenceForStage(stage: HarnessRunStage): HarnessEvidenceKind[] {
  return [...(STAGE_EVIDENCE[stage] ?? [])];
}function hasEvidence(
  evidence: HarnessEvidenceRecord[],
  stage: HarnessRunStage,
  kind: HarnessEvidenceKind,
): boolean {
  return evidence.some((item) => item.stage === stage && item.kind === kind);
}

export function assertStageCompletionEvidence(
  stage: HarnessRunStage,
  evidence: HarnessEvidenceRecord[],
): void {
  const required = requiredEvidenceForStage(stage);
  const missing = required.filter((kind) => !hasEvidence(evidence, stage, kind));
  if (missing.length > 0) {
    throw new Error(`Stage ${stage} is missing required evidence: ${missing.join(", ")}`);
  }
}

export function assertRunCompletionEvidence(
  evidence: HarnessEvidenceRecord[],
): void {
  const missing: string[] = [];
  for (const stage of DEFAULT_DELIVERY_STAGES) {
    for (const kind of requiredEvidenceForStage(stage)) {
      if (!hasEvidence(evidence, stage, kind)) missing.push(kind);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Run completion is missing required evidence: ${missing.join(", ")}`);
  }
}