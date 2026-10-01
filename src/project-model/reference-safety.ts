import { assertCheckHttpUrl } from "../desktop-agent/contracts.js";

const OPAQUE_REFERENCE_SCHEMES = new Set([
  "build", "calendar", "desktop-job", "discord", "discord-binding", "figma",
  "github", "history", "notion", "pull-request", "reasoning-turn",
]);

const CREDENTIAL_ASSIGNMENT = /\b(access[_ -]?token|oauth[_ -]?token|token|cookie|secret|password|api[_ -]?key|client[_ -]?secret)\b\s*[:=]/i;
const BEARER_CREDENTIAL = /\bBearer\s+[^\s,;}]+/i;

function containsCredentialLikeContent(value: string): boolean {
  if (CREDENTIAL_ASSIGNMENT.test(value) || BEARER_CREDENTIAL.test(value)) return true;
  try {
    const decoded = decodeURIComponent(value);
    return CREDENTIAL_ASSIGNMENT.test(decoded) || BEARER_CREDENTIAL.test(decoded);
  } catch {
    return false;
  }
}

export function sanitizeProjectEvidenceReference(value: string): string | undefined {
  const candidate = value.trim();
  const scheme = /^[A-Za-z][A-Za-z\d+.-]*:/.exec(candidate)?.[0]?.slice(0, -1).toLowerCase();
  if (candidate !== value || /[\u0000-\u001f\u007f]/.test(value) || candidate.startsWith("//") || /%(?![0-9a-f]{2})/i.test(candidate)) return undefined;
  if (containsCredentialLikeContent(candidate)) return undefined;
  if (/^https?:\/\//i.test(candidate)) {
    try {
      assertCheckHttpUrl(value);
      return value;
    } catch {
      return undefined;
    }
  }
  const nestedHttpUrl = /(https?:\/\/\S+)/i.exec(candidate)?.[1];
  if (nestedHttpUrl) {
    try {
      assertCheckHttpUrl(nestedHttpUrl);
    } catch {
      return undefined;
    }
  }
  if (scheme && !OPAQUE_REFERENCE_SCHEMES.has(scheme)) return undefined;
  return value;
}
