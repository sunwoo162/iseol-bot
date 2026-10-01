import { isSensitiveHttpCredentialKey } from "../desktop-agent/contracts.js";
import { sanitizeProjectEvidenceReference } from "../project-model/reference-safety.js";

const BEARER_CREDENTIAL = /\bBearer\s+[^\s,;}]+/gi;
const HTTP_URL = /https?:\/\/[^\s,;}]+/gi;
const URL_CREDENTIAL_ASSIGNMENT = /([?&#])([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*([^\s&#,;}]+)/g;
const CREDENTIAL_ASSIGNMENT = /(^|[^A-Za-z0-9_-])(["']?)([A-Za-z][A-Za-z0-9_-]*)\2\s*([:=])\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\)\]]+)/g;

function decodeForCredentialInspection(value: string): string | undefined {
  let current = value;
  for (let index = 0; index < 2 && /%[0-9a-f]{2}/i.test(current); index += 1) {
    if (/%(?![0-9a-f]{2})/i.test(current)) return undefined;
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      current = decoded;
    } catch {
      return undefined;
    }
  }
  return /%[0-9a-f]{2}/i.test(current) || /%(?![0-9a-f]{2})/i.test(current) ? undefined : current;
}

function sanitizeRawCredentialText(value: string, maxLength: number): string {
  return value
    .replace(BEARER_CREDENTIAL, "Bearer [redacted]")
    .replace(HTTP_URL, (url) => sanitizeProjectEvidenceReference(url) ?? "[redacted-url]")
    .replace(URL_CREDENTIAL_ASSIGNMENT, (match, prefix: string, key: string) => (
      isSensitiveHttpCredentialKey(key) ? `${prefix}${key}=[redacted]` : match
    ))
    .replace(CREDENTIAL_ASSIGNMENT, (match, prefix: string, keyQuote: string, key: string, separator: string, value: string) => {
      if (!isSensitiveHttpCredentialKey(key)) return match;
      const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
      return `${prefix}${keyQuote}${key}${keyQuote}${separator}${quote}[redacted]${quote}`;
    })
    .slice(0, maxLength);
}

export function sanitizeCredentialText(value: string, maxLength = 240): string {
  const sanitized = sanitizeRawCredentialText(value, maxLength);
  if (!/%[0-9a-f]{2}/i.test(value)) return sanitized;
  const decoded = decodeForCredentialInspection(value);
  if (decoded === undefined) return "[redacted]".slice(0, maxLength);
  const decodedSanitized = sanitizeRawCredentialText(decoded, Math.max(maxLength, decoded.length));
  if (decodedSanitized !== decoded && (decodedSanitized.includes("[redacted]") || decodedSanitized.includes("[redacted-url]"))) {
    return decodedSanitized.slice(0, maxLength);
  }
  return sanitized;
}
