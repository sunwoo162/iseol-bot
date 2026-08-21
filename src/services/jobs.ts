import { config } from "../config.js";

const SARAMIN_API_URL = "https://oapi.saramin.co.kr/job-search";
const WORK24_API_URL = "https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_JOBS_PER_FIELD = 60;

export type JobField =
  | "frontend"
  | "backend"
  | "fullstack"
  | "mobile"
  | "data-ai"
  | "devops-cloud"
  | "security"
  | "embedded";

export type JobSource = "사람인" | "고용24";

export type JobPosting = {
  id: string;
  sourceIds: string[];
  title: string;
  company: string;
  field: JobField;
  url: string;
  condition?: string;
  sector?: string;
  deadline?: string;
  sources: JobSource[];
};

type JobFieldDefinition = {
  label: string;
  channelName: string;
  saraminJobCodes: string[];
  work24Keyword: string;
};

export const JOB_FIELD_DEFINITIONS: Record<JobField, JobFieldDefinition> = {
  frontend: {
    label: "프론트엔드",
    channelName: "🖥・프론트엔드",
    saraminJobCodes: ["92"],
    work24Keyword: "프론트엔드",
  },
  backend: {
    label: "백엔드/서버",
    channelName: "⚙️・백엔드",
    saraminJobCodes: ["84"],
    work24Keyword: "백엔드",
  },
  fullstack: {
    label: "풀스택",
    channelName: "🧩・풀스택",
    saraminJobCodes: ["2232"],
    work24Keyword: "풀스택",
  },
  mobile: {
    label: "앱/모바일",
    channelName: "📱・앱-모바일",
    saraminJobCodes: ["86", "195", "220", "234", "243", "278", "298"],
    work24Keyword: "앱개발",
  },
  "data-ai": {
    label: "AI/데이터",
    channelName: "🤖・ai-데이터",
    saraminJobCodes: ["82", "83", "108", "109", "116", "160", "181", "2248"],
    work24Keyword: "인공지능",
  },
  "devops-cloud": {
    label: "DevOps/클라우드",
    channelName: "☁️・devops-클라우드",
    saraminJobCodes: ["127", "136", "146", "201", "202", "214", "221", "237", "244"],
    work24Keyword: "DevOps",
  },
  security: {
    label: "정보보안",
    channelName: "🔐・정보보안",
    saraminJobCodes: ["85", "90", "111", "121", "132", "147", "157", "173", "177", "190", "2239"],
    work24Keyword: "정보보안",
  },
  embedded: {
    label: "임베디드",
    channelName: "🔧・임베디드",
    saraminJobCodes: ["128", "139", "151", "158", "166", "186", "308", "319", "320"],
    work24Keyword: "임베디드",
  },
};

export const JOB_FIELDS = Object.keys(JOB_FIELD_DEFINITIONS) as JobField[];

export function jobFieldLabel(field: JobField): string {
  return JOB_FIELD_DEFINITIONS[field].label;
}

export function isJobField(value: string): value is JobField {
  return value in JOB_FIELD_DEFINITIONS;
}

export function getConfiguredJobSources(): JobSource[] {
  const sources: JobSource[] = [];
  if (config.saraminApiKey) sources.push("사람인");
  if (config.work24ApiKey) sources.push("고용24");
  return sources;
}

function clean(value?: string): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text || undefined;
}

function compact(values: Array<string | undefined>): string | undefined {
  const items = values.map((value) => clean(value)).filter((value): value is string => Boolean(value));
  return items.length > 0 ? items.join(" · ") : undefined;
}

function normalizeDedupePart(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\(주\)|주식회사|㈜/g, "")
    .replace(/[^a-z0-9가-힣]/g, "")
    .trim();
}

function postingKey(company: string, title: string, fallbackId: string): string {
  const companyKey = normalizeDedupePart(company);
  const titleKey = normalizeDedupePart(title);
  if (!companyKey || !titleKey) return fallbackId;
  return `${companyKey}:${titleKey}`;
}

function isTrainingPosting(posting: Pick<JobPosting, "title" | "condition" | "sector">): boolean {
  const text = `${posting.title} ${posting.condition ?? ""} ${posting.sector ?? ""}`.normalize("NFKC");
  return /교육생|교육\s*과정|양성\s*과정|부트\s*캠프|아카데미|국비\s*지원|취업\s*캠프|훈련생/.test(text);
}

type SaraminNamedValue = {
  code?: string | number;
  name?: string;
};

type SaraminJob = {
  id?: string | number;
  url?: string;
  active?: string | number;
  company?: {
    detail?: {
      name?: string;
    };
  };
  position?: {
    title?: string;
    location?: SaraminNamedValue;
    "job-type"?: SaraminNamedValue;
    "job-code"?: SaraminNamedValue;
    "experience-level"?: SaraminNamedValue;
    "required-education-level"?: SaraminNamedValue;
  };
  keyword?: string;
  salary?: SaraminNamedValue;
  "expiration-timestamp"?: string | number;
  "expiration-date"?: string;
  "close-type"?: SaraminNamedValue;
};

type SaraminResponse = {
  jobs?: {
    job?: SaraminJob | SaraminJob[];
  };
  code?: string | number;
  message?: string;
};

function formatSaraminDeadline(job: SaraminJob): string | undefined {
  const closeType = job["close-type"];
  const closeCode = String(closeType?.code ?? "");
  if (closeCode === "2" || closeCode === "3" || closeCode === "4") return clean(closeType?.name);

  const expirationDate = clean(job["expiration-date"]);
  if (expirationDate) return expirationDate.slice(0, 10);

  const timestamp = Number(job["expiration-timestamp"]);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return new Date(timestamp * 1000).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" });
  }

  return clean(closeType?.name);
}

function parseSaraminJob(job: SaraminJob, field: JobField): JobPosting | null {
  if (String(job.active ?? "1") === "0") return null;

  const rawId = String(job.id ?? "").trim();
  const title = clean(job.position?.title);
  const company = clean(job.company?.detail?.name);
  const url = clean(job.url);
  if (!rawId || !title || !company || !url) return null;

  const condition = compact([
    job.position?.location?.name,
    job.position?.["experience-level"]?.name,
    job.position?.["required-education-level"]?.name,
    job.position?.["job-type"]?.name,
    job.salary?.name,
  ]);
  const sector = compact([job.position?.["job-code"]?.name, job.keyword]);
  const sourceId = `saramin:${rawId}`;
  const posting: JobPosting = {
    id: postingKey(company, title, sourceId),
    sourceIds: [rawId, sourceId],
    title,
    company,
    field,
    url,
    condition,
    sector,
    deadline: formatSaraminDeadline(job),
    sources: ["사람인"],
  };

  return isTrainingPosting(posting) ? null : posting;
}

async function fetchSaraminJobs(field: JobField): Promise<JobPosting[]> {
  if (!config.saraminApiKey) return [];

  const definition = JOB_FIELD_DEFINITIONS[field];
  const params = new URLSearchParams({
    "access-key": config.saraminApiKey,
    job_cd: definition.saraminJobCodes.join(","),
    fields: "expiration-date",
    count: "50",
    sort: "pd",
  });
  const response = await fetch(`${SARAMIN_API_URL}?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`사람인 API HTTP ${response.status}`);
  const data = await response.json() as SaraminResponse;
  if (data.code !== undefined) throw new Error(`사람인 API 오류 ${data.code}: ${data.message ?? "알 수 없는 오류"}`);

  const raw = data.jobs?.job;
  const jobs = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return jobs.map((job) => parseSaraminJob(job, field)).filter((job): job is JobPosting => job !== null);
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function xmlValue(block: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match?.[1] ? clean(decodeXml(match[1])) : undefined;
}

function work24Education(block: string): string | undefined {
  const min = xmlValue(block, "minEdubg");
  const max = xmlValue(block, "maxEdubg");
  if (min && max && min !== max) return `${min}~${max}`;
  return min ?? max;
}

function parseWork24List(xml: string, field: JobField): JobPosting[] {
  const keyword = JOB_FIELD_DEFINITIONS[field].work24Keyword;
  const jobs: JobPosting[] = [];

  for (const match of xml.matchAll(/<wanted>([\s\S]*?)<\/wanted>/gi)) {
    const block = match[1];
    if (!block) continue;

    const rawId = xmlValue(block, "wantedAuthNo");
    const title = xmlValue(block, "title");
    const company = xmlValue(block, "company");
    const url = xmlValue(block, "wantedInfoUrl");
    if (!rawId || !title || !company || !url) continue;

    const condition = compact([
      xmlValue(block, "region"),
      xmlValue(block, "career"),
      work24Education(block),
      compact([xmlValue(block, "salTpNm"), xmlValue(block, "sal")]),
    ]);
    const sector = compact([keyword, xmlValue(block, "indTpNm")]);
    const sourceId = `work24:${rawId}`;
    const posting: JobPosting = {
      id: postingKey(company, title, sourceId),
      sourceIds: [sourceId],
      title,
      company,
      field,
      url,
      condition,
      sector,
      deadline: xmlValue(block, "closeDt"),
      sources: ["고용24"],
    };

    if (!isTrainingPosting(posting)) jobs.push(posting);
  }

  return jobs;
}

async function fetchWork24Jobs(field: JobField): Promise<JobPosting[]> {
  if (!config.work24ApiKey) return [];

  const params = new URLSearchParams({
    authKey: config.work24ApiKey,
    callTp: "L",
    returnType: "XML",
    startPage: "1",
    display: "50",
    keyword: JOB_FIELD_DEFINITIONS[field].work24Keyword,
    sortOrderBy: "DESC",
  });
  const response = await fetch(`${WORK24_API_URL}?${params.toString()}`, {
    headers: { Accept: "application/xml,text/xml" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`고용24 API HTTP ${response.status}`);
  const xml = await response.text();
  const errorMessage = xmlValue(xml, "message");
  if (!/<wantedRoot[\s>]/i.test(xml) && errorMessage) throw new Error(`고용24 API 오류: ${errorMessage}`);
  return parseWork24List(xml, field);
}

function richer(current?: string, incoming?: string): string | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  return incoming.length > current.length ? incoming : current;
}

function mergePosting(current: JobPosting, incoming: JobPosting): JobPosting {
  return {
    ...current,
    sourceIds: [...new Set([...current.sourceIds, ...incoming.sourceIds])],
    sources: [...new Set([...current.sources, ...incoming.sources])],
    condition: richer(current.condition, incoming.condition),
    sector: richer(current.sector, incoming.sector),
    deadline: current.deadline ?? incoming.deadline,
  };
}

let warnedMissingSources = false;

export async function listActiveDeveloperJobs(field: JobField): Promise<JobPosting[]> {
  const loaders: Array<{ source: JobSource; load: () => Promise<JobPosting[]> }> = [];
  if (config.saraminApiKey) loaders.push({ source: "사람인", load: () => fetchSaraminJobs(field) });
  if (config.work24ApiKey) loaders.push({ source: "고용24", load: () => fetchWork24Jobs(field) });

  if (loaders.length === 0) {
    if (!warnedMissingSources) {
      console.warn("취업 공고 API 키가 없습니다. SARAMIN_API_KEY 또는 WORK24_API_KEY를 설정해주세요.");
      warnedMissingSources = true;
    }
    return [];
  }

  const settled = await Promise.allSettled(loaders.map(({ load }) => load()));
  const merged = new Map<string, JobPosting>();

  settled.forEach((result, index) => {
    const source = loaders[index]?.source ?? "알 수 없음";
    if (result.status === "rejected") {
      console.warn(`취업 공고 API 조회 실패 (${source}/${jobFieldLabel(field)})`, result.reason);
      return;
    }

    for (const posting of result.value) {
      const current = merged.get(posting.id);
      merged.set(posting.id, current ? mergePosting(current, posting) : posting);
    }
  });

  return [...merged.values()].slice(0, MAX_JOBS_PER_FIELD);
}
