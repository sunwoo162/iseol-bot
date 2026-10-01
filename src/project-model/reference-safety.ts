import { assertCheckHttpUrl } from "../desktop-agent/contracts.js";

const OPAQUE_REFERENCE_SCHEMES = new Set(["build", "calendar", "desktop-job", "discord", "github", "pull-request"]);

export function sanitizeProjectEvidenceReference(value: string): string | undefined {
  const candidate = value.trim();
  const scheme = /^[A-Za-z][A-Za-z\d+.-]*:/.exec(candidate)?.[0]?.slice(0, -1).toLowerCase();
  if (candidate !== value || /[\u0000-\u001f\u007f]/.test(value) || candidate.startsWith("//")) return undefined;
  if (/^https?:\/\//i.test(candidate)) {
    if (/%(?![0-9a-f]{2})/i.test(candidate)) return undefined;
    try {
      assertCheckHttpUrl(value);
      return value;
    } catch {
      return undefined;
    }
  }
  if (scheme && !OPAQUE_REFERENCE_SCHEMES.has(scheme)) return undefined;
  return value;
}
