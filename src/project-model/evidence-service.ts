import type { HarnessEvidenceRecord } from "../harness/contracts.js";
import { assertCheckHttpUrl } from "../desktop-agent/contracts.js";

function sanitizeProjectEvidence(item: HarnessEvidenceRecord): HarnessEvidenceRecord {
  const reference = item.reference;
  if (reference === undefined) return item;
  if (/^https?:/i.test(reference)) {
    try {
      assertCheckHttpUrl(reference);
      return item;
    } catch {
      const { reference: _unsafeReference, ...sanitized } = item;
      return sanitized;
    }
  }
  if (/^(?:javascript|data|vbscript):/i.test(reference) || /^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(reference)) {
    const { reference: _unsafeReference, ...sanitized } = item;
    return sanitized;
  }
  return item;
}

export function selectProjectEvidence(input: {
  projectId: string;
  runId: string;
  evidence: readonly HarnessEvidenceRecord[];
}): HarnessEvidenceRecord[] {
  // Both durable identities are required. A single matching field is not
  // enough to prove that an evidence record belongs to this user project.
  return input.evidence
    .filter((item) => item.projectId === input.projectId && item.runId === input.runId)
    .map(sanitizeProjectEvidence);
}
