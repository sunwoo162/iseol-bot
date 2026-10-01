import type { HarnessEvidenceRecord } from "../harness/contracts.js";
import { assertCheckHttpUrl } from "../desktop-agent/contracts.js";

const OPAQUE_REFERENCE_SCHEMES = new Set(["build", "calendar", "desktop-job", "discord", "github", "pull-request"]);

function sanitizeProjectEvidence(item: HarnessEvidenceRecord): HarnessEvidenceRecord {
  const reference = item.reference;
  if (reference === undefined) return item;
  const candidate = reference.trim();
  const scheme = /^[A-Za-z][A-Za-z\d+.-]*:/.exec(candidate)?.[0]?.slice(0, -1).toLowerCase();
  const hasControlCharacter = /[\u0000-\u001f\u007f]/.test(reference);
  const removeReference = () => {
    const { reference: _unsafeReference, ...sanitized } = item;
    return sanitized;
  };
  if (candidate !== reference || hasControlCharacter) return removeReference();
  if (candidate.startsWith("//")) return removeReference();
  if (/^https?:\/\//i.test(candidate)) {
    try {
      assertCheckHttpUrl(reference);
      return item;
    } catch {
      return removeReference();
    }
  }
  if (scheme && !OPAQUE_REFERENCE_SCHEMES.has(scheme)) return removeReference();
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
