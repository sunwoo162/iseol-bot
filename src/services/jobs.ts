const SARAMIN_BASE = "https://www.saramin.co.kr";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JOBS_PER_FIELD = 50;

export type JobField =
  | "frontend"
  | "backend"
  | "fullstack"
  | "mobile"
  | "data-ai"
  | "devops-cloud"
  | "security"
  | "embedded";

export type JobPosting = {
  id: string;
  title: string;
  company: string;
  field: JobField;
  url: string;
  condition?: string;
  sector?: string;
  deadline?: string;
  source: "사람인";
};

type JobFieldDefinition = {
  label: string;
  channelName: string;
  categoryIds: number[];
};

export const JOB_FIELD_DEFINITIONS: Record<JobField, JobFieldDefinition> = {
  frontend: {
    label: "프론트엔드",
    channelName: "🖥・프론트엔드",
    categoryIds: [92],
  },
  backend: {
    label: "백엔드/서버",
    channelName: "⚙️・백엔드",
    categoryIds: [84],
  },
  fullstack: {
    label: "풀스택",
    channelName: "🧩・풀스택",
    categoryIds: [2232],
  },
  mobile: {
    label: "앱/모바일",
    channelName: "📱・앱-모바일",
    categoryIds: [86],
  },
  "data-ai": {
    label: "AI/데이터",
    channelName: "🤖・ai-데이터",
    categoryIds: [83, 856, 181],
  },
  "devops-cloud": {
    label: "DevOps/클라우드",
    channelName: "☁️・devops-클라우드",
    categoryIds: [146, 136],
  },
  security: {
    label: "정보보안",
    channelName: "🔐・정보보안",
    categoryIds: [90],
  },
  embedded: {
    label: "임베디드",
    channelName: "🔧・임베디드",
    categoryIds: [128],
  },
};

export const JOB_FIELDS = Object.keys(JOB_FIELD_DEFINITIONS) as JobField[];

export function jobFieldLabel(field: JobField): string {
  return JOB_FIELD_DEFINITIONS[field].label;
}

export function isJobField(value: string): value is JobField {
  return value in JOB_FIELD_DEFINITIONS;
}

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

function firstClassBlock(segment: string, className: string): string {
  const classPattern = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = segment.match(new RegExp(
    `<(?:div|p|strong|h2)\\b[^>]*class=["'][^"']*\\b${classPattern}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:div|p|strong|h2)>`,
    "i",
  ));
  return match?.[1] ?? "";
}

function normalizeJobUrl(href: string): { id: string; url: string } | null {
  try {
    const url = new URL(decodeHtml(href), SARAMIN_BASE);
    const recIdx = url.searchParams.get("rec_idx") ?? url.pathname.match(/\/(\d+)(?:\/)?$/)?.[1];
    if (!recIdx || !/^\d+$/.test(recIdx)) return null;

    return {
      id: recIdx,
      url: `${SARAMIN_BASE}/zf_user/jobs/relay/view?rec_idx=${recIdx}`,
    };
  } catch {
    return null;
  }
}

function isTrainingPosting(posting: Pick<JobPosting, "title" | "condition" | "sector">): boolean {
  const text = `${posting.title} ${posting.condition ?? ""} ${posting.sector ?? ""}`.normalize("NFKC");
  return /교육생|교육\s*과정|양성\s*과정|부트\s*캠프|아카데미|국비\s*지원|취업\s*캠프|훈련생/.test(text);
}

function parseSaraminList(html: string, field: JobField): JobPosting[] {
  const segments = html.split(/<div\b[^>]*class=["'][^"']*\bitem_recruit\b[^"']*["'][^>]*>/gi).slice(1);
  const jobs: JobPosting[] = [];

  for (const segment of segments) {
    const titleBlock = firstClassBlock(segment, "job_tit");
    if (!titleBlock) continue;

    const anchor = titleBlock.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const href = anchor?.[1];
    const title = stripTags(anchor?.[2] ?? titleBlock);
    if (!href || !title) continue;

    const normalized = normalizeJobUrl(href);
    if (!normalized) continue;

    const company = stripTags(firstClassBlock(segment, "corp_name"));
    const condition = stripTags(firstClassBlock(segment, "job_condition")) || undefined;
    const sector = stripTags(firstClassBlock(segment, "job_sector")) || undefined;
    const deadline = stripTags(firstClassBlock(segment, "job_date")) || undefined;

    const posting: JobPosting = {
      id: normalized.id,
      title,
      company: company || "회사명 확인 필요",
      field,
      url: normalized.url,
      condition,
      sector,
      deadline,
      source: "사람인",
    };

    if (isTrainingPosting(posting)) continue;
    jobs.push(posting);
  }

  return jobs;
}

async function fetchSaraminCategory(categoryId: number, field: JobField): Promise<JobPosting[]> {
  const url = `${SARAMIN_BASE}/zf_user/jobs/list/job-category?cat_kewd=${categoryId}&nomo=1`;
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
      "User-Agent": "Mozilla/5.0 (compatible; IseolBot/1.0; +Discord developer job aggregator)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`사람인 HTTP ${response.status}`);
  return parseSaraminList(await response.text(), field);
}

export async function listActiveDeveloperJobs(field: JobField): Promise<JobPosting[]> {
  const definition = JOB_FIELD_DEFINITIONS[field];
  const settled = await Promise.allSettled(
    definition.categoryIds.map((categoryId) => fetchSaraminCategory(categoryId, field)),
  );
  const merged = new Map<string, JobPosting>();

  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      console.warn(`취업 공고 조회 실패 (사람인 ${definition.label}/${definition.categoryIds[index]})`, result.reason);
      return;
    }

    for (const posting of result.value) {
      if (!merged.has(posting.id)) merged.set(posting.id, posting);
    }
  });

  return [...merged.values()].slice(0, MAX_JOBS_PER_FIELD);
}
