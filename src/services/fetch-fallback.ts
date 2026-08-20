import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const nativeFetch = globalThis.fetch.bind(globalThis);

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function isAllconUrl(url: string | null): boolean {
  if (!url) return false;

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "all-con.co.kr" || hostname.endsWith(".all-con.co.kr");
  } catch {
    return false;
  }
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
  const headers = new Headers(init?.headers);
  const args = [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--compressed",
    "--max-time",
    "15",
  ];

  for (const [name, value] of headers.entries()) {
    args.push("--header", `${name}: ${value}`);
  }

  args.push(url);

  const result = await execFileAsync("curl", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const body = typeof result.stdout === "string"
    ? result.stdout
    : result.stdout.toString("utf8");

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const fetchWithAllconFallback: typeof globalThis.fetch = async (input, init) => {
  const url = requestUrl(input);

  try {
    return await nativeFetch(input, init);
  } catch (error) {
    if (!isAllconUrl(url) || !isCertificateChainError(error) || !url) throw error;

    console.warn("올콘 HTTPS 인증서 체인 검증 실패: 시스템 curl로 재시도합니다.");
    return fetchAllconWithCurl(url, init);
  }
};

globalThis.fetch = fetchWithAllconFallback;
