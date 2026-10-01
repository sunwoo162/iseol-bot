import { isSensitiveHttpCredentialKey } from "../desktop-agent/contracts.js";
import { sanitizeProjectEvidenceReference } from "../project-model/reference-safety.js";

const BEARER_CREDENTIAL = /\bBearer\s+[^\s,;}]+/gi;
const HTTP_URL = /https?:\/\/[^\s,;}]+/gi;
const URL_CREDENTIAL_ASSIGNMENT = /([?&#])([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*([^\s&#,;}]+)/g;
const CREDENTIAL_ASSIGNMENT = /(^|[^A-Za-z0-9_-])(["']?)([A-Za-z][A-Za-z0-9_-]*)\2\s*([:=])\s*("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\)\]]+)/g;

export function sanitizeCredentialText(value: string, maxLength = 240): string {
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
