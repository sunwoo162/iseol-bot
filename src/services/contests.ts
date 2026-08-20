const WEVITY_BASE_URL = "https://www.wevity.com";
const WEVITY_IT_LIST_URL = `${WEVITY_BASE_URL}/?c=find&cidx=20&gub=1&mode=ing`;
const MAX_PAGES = 50;

export type Contest = {
  title: string;
  url: string;
  status?: string;
  source: "WEVITY";
};

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };

  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(href: string): string | null {
  try {
    const url = new URL(decodeHtml(href), WEVITY_BASE_URL);
    if (url.protocol !== "https:" || url.hostname !== "www.wevity.com") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseContestList(html: string): Contest[] {
  const contests: Contest[] = [];
  const titlePattern = /<[^>]+class=["'][^"']*\btit\b[^"']*["'][^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(titlePattern)) {
    const href = match[1];
    const anchorHtml = match[2];
    if (!href || !anchorHtml) continue;

    const url = normalizeUrl(href);
    if (!url || !/[?&](?:ix|gbn)=/.test(url)) continue;

    const status = [...anchorHtml.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
      .map((span) => stripTags(span[1] ?? ""))
      .filter(Boolean)
      .join(" ");
    const title = stripTags(anchorHtml.replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, " "));

    if (!title) continue;
    contests.push({ title, url, status: status || undefined, source: "WEVITY" });
  }

  return contests;
}

async function fetchPage(page: number): Promise<Contest[]> {
  const response = await fetch(`${WEVITY_IT_LIST_URL}&gp=${page}`, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "IseolBot/1.0 contest-list (+Discord project bot)",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`공모전 목록 요청 실패 (${response.status})`);
  }

  return parseContestList(await response.text());
}

export async function listActiveItContests(): Promise<Contest[]> {
  const all = new Map<string, Contest>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const contests = await fetchPage(page);
    if (contests.length === 0) break;

    const before = all.size;
    for (const contest of contests) all.set(contest.url, contest);
    if (all.size === before) break;
  }

  return [...all.values()];
}
