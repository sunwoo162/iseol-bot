import { sanitizeCredentialText } from "./text-safety.js";

export function formatUserFacingError(error: unknown, fallback = "알 수 없는 오류가 발생했습니다."): string {
  const rawMessage = error instanceof Error ? error.message : fallback;
  return sanitizeCredentialText(rawMessage.replace(/[\r\n]+/g, " "), 240);
}
