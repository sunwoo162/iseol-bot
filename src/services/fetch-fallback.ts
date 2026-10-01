import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const nativeFetch = globalThis.fetch.bind(globalThis);
const ALLCON_HOSTS = new Set(["all-con.co.kr", "www.all-con.co.kr"]);
const CURL_STATUS_MARKER = "__ISEOL_CURL_STATUS__";

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function isAllconUrl(url: string | null): boolean {
  if (!url || url.includes("\\") || /%5c/i.test(url)) return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && ALLCON_HOSTS.has(parsed.hostname.toLowerCase())
      && !parsed.username
      && !parsed.password
      && !parsed.port;
  } catch {
    return false;
  }
}

export function buildAllconCurlArgs(
  url: string,
  init?: Parameters<typeof globalThis.fetch>[1],
): string[] {
  if (!isAllconUrl(url)) throw new Error("Allcon fallback URL is not allowed");

  const headers = new Headers(init?.headers);
  const args = [
    "--fail",
    "--silent",
    "--show-error",
    "--compressed",
    "--insecure",
    "--max-time",
    "15",
    "--max-redirs",
    "0",
    "--write-out",
    `\n${CURL_STATUS_MARKER}%{http_code}`,
  ];

  for (const [name, value] of headers.entries()) {
    args.push("--header", `${name}: ${value}`);
  }

  args.push(url);
  return args;
}

function isCertificateChainError(error: unknown): boolean {
  let current: unknown = error;

  while (current && typeof current === "object") {
    const code = "code" in current ? String(current.code) : "";
    if (
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
      || code === "UNABLE_TO_GET_ISSUER_CERT"
      || code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
      || code === "CERT_UNTRUSTED"
    ) {
      return true;
    }

    current = "cause" in current ? current.cause : null;
  }

  return false;
}

async function fetchAllconWithCurl(
  url: string,
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
  const result = await execFileAsync("curl", buildAllconCurlArgs(url, init), {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = String(result.stdout);
  const marker = `\n${CURL_STATUS_MARKER}`;
  const markerIndex = output.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error("Allcon fallback response status is missing");

  const status = Number(output.slice(markerIndex + marker.length).trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error("Allcon fallback response status is invalid");
  }

  return new Response(output.slice(0, markerIndex), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const fetchWithAllconFallback: typeof globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);

  try {
    return await nativeFetch(input, init);
  } catch (error) {
    if (!isAllconUrl(url) || !isCertificateChainError(error) || !url) throw error;

    console.warn("올콘 HTTPS 인증서 체인 검증 실패: 올콘 전용 비검증 curl fallback으로 재시도합니다.");
    return fetchAllconWithCurl(url, init);
  }
};

globalThis.fetch = fetchWithAllconFallback;
