import type { HarnessEvidenceRecord } from "../harness/contracts.js";

export function selectProjectEvidence(input: {
  projectId: string;
  runId: string;
  evidence: readonly HarnessEvidenceRecord[];
}): HarnessEvidenceRecord[] {
  // Both durable identities are required. A single matching field is not
  // enough to prove that an evidence record belongs to this user project.
  return input.evidence.filter((item) => item.projectId === input.projectId && item.runId === input.runId);
}
