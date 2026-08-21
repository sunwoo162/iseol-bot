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

export type JobSource = "사람인" | "고용24" | "잡코리아";

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
  jobkoreaMatchers: RegExp[];
};

export const JOB_FIELD_DEFINITIONS: Record<JobField, JobFieldDefinition> = {
  frontend: {
    label: "프론트엔드",
    channelName: "🖥・프론트엔드",
    saraminJobCodes: ["92"],
    work24Keyword: "프론트엔드",
    jobkoreaMatchers: [/프론트\s*엔드/i, /frontend/i, /react(?:\.js)?/i, /vue(?:\.js)?/i, /angular/i, /next(?:\.js)?/i],
  },
  backend: {
    label: "백엔드/서버",
    channelName: "⚙️・백엔드",
    saraminJobCodes: ["84"],
    work24Keyword: "백엔드",
    jobkoreaMatchers: [/백\s*엔드/i, /서버\s*개발/i, /backend/i, /spring/i, /nest(?:js)?/i, /django/i, /fastapi/i],
  },
  fullstack: {
    label: "풀스택",
    channelName: "🧩・풀스택",
    saraminJobCodes: ["2232"],
    work24Keyword: "풀스택",
    jobkoreaMatchers: [/풀\s*스택/i, /full\s*stack/i],
  },
  mobile: {
    label: "앱/모바일",
    channelName: "📱・앱-모바일",
    saraminJobCodes: ["86", "195", "220", "234", "243", "278", "298"],
    work24Keyword: "앱개발",
    jobkoreaMatchers: [/앱\s*개발/i, /모바일\s*개발/i, /android/i, /ios/i, /flutter/i, /react\s*native/i, /kotlin/i, /swift/i],
  },
  "data-ai": {
    label: "AI/데이터",
    channelName: "🤖・ai-데이터",
    saraminJobCodes: ["82", "83", "108", "109", "116", "160", "181", "2248"],
    work24Keyword: "인공지능",
    jobkoreaMatchers: [/인공\s*지능/i, /머신\s*러닝/i, /딥\s*러닝/i, /데이터\s*(?:사이언|엔지니어)/i, /machine\s*learning/i, /data\s*(?:scientist|engineer)/i, /(?:^|[^a-z])ai(?:[^a-z]|$)/i, /(?:^|[^a-z])ml(?:[^a-z]|$)/i],
  },
  "devops-cloud": {
    label: "DevOps/클라우드",
    channelName: "☁️・devops-클라우드",
    saraminJobCodes: ["127", "136", "146", "201", "202", "214", "221", "237", "244"],
    work24Keyword: "DevOps",
    jobkoreaMatchers: [/devops/i, /클라우드/i, /(?:^|[^a-z])sre(?:[^a-z]|$)/i, /kubernetes/i, /docker/i, /(?:^|[^a-z])aws(?:[^a-z]|$)/i, /(?:^|[^a-z])gcp(?:[^a-z]|$)/i, /azure/i, /인프라/i],
  },
  security: {
    label: "정보보안",
    channelName: "🔐・정보보안",
    saraminJobCodes: ["85", "90", "111", "121", "132", "147", "157", "173", "177", "190", "2239"],
    work24Keyword: "정보보안",
    jobkoreaMatchers: [/정보\s*보안/i, /보안\s*(?:개발|엔지니어|관제)/i, /security/i, /secops/i, /침해\s*대응/i, /취약점/i, /pentest/i],
  },
  embedded: {
    label: "임베디드",
    channelName: "🔧・임베디드",
    saraminJobCodes: ["128", "139", "151", "158", "166", "186", "308", "319", "320"],
    work24Keyword: "임베디드",
    jobkoreaMatchers: [/임베디드/i, /embedded/i, /펌웨어/i, /firmware/i, /(?:^|[^a-z])mcu(?:[^a-z]|$)/i],
  },
};

export const JOB_FIELDS = Object.keys(JOB_FIELD_DEFINITIONS) as JobField[];

export function jobFieldLabel(field: JobField): string {
  return JOB_FIELD_DEFINITIONS[field].label;
}

export function isJobField(value: string): value is JobField {
  return value in JOB_FIELD_DEFINITIONS;
}

function hasJobKoreaConfig(): boolean {
  return Boolean(config.jobkoreaApiUrl && config.jobkoreaApiKey);
}

export function getConfiguredJobSources(): JobSource[] {
  const sources: JobSource[] = [];
  if (config.saraminApiKey) sources.push("사람인");
  if (config.work24ApiKey) sources.push("고용24");
  if (hasJobKoreaConfig()) sources.push("잡코리아");
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

function normalizeJobKoreaUrl(value: string): string {
  if (value.startsWith("http://www.jobkorea.co.kr/")) return `https://${value.slice("http://".length)}`;
  return value;
}

function formatJobKoreaDate(value?: string): string | undefined {
  const raw = clean(value)?.replace(/[^0-9]/g, "");
  if (!raw || raw.length !== 8) return clean(value);
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function matchesJobKoreaField(field: JobField, title: string, keyword?: string): boolean {
  const text = `${title} ${keyword ?? ""}`.normalize("NFKC");
  return JOB_FIELD_DEFINITIONS[field].jobkoreaMatchers.some((matcher) => matcher.test(text));
}

function parseJobKoreaList(xml: string, field: JobField): JobPosting[] {
  const jobs: JobPosting[] = [];

  for (const match of xml.matchAll(/<Items>([\s\S]*?)<\/Items>/gi)) {
    const block = match[1];
    if (!block) continue;

    const rawId = xmlValue(block, "GI_No");
    const title = xmlValue(block, "GI_Subject");
    const company = xmlValue(block, "C_Name");
    const rawUrl = xmlValue(block, "JK_URL");
    const keyword = xmlValue(block, "GI_Keyword");
    if (!rawId || !title || !company || !rawUrl) continue;
    if (!matchesJobKoreaField(field, title, keyword)) continue;

    const sourceId = `jobkorea:${rawId}`;
    const posting: JobPosting = {
      id: postingKey(company, title, sourceId),
      sourceIds: [sourceId],
      title,
      company,
      field,
      url: normalizeJobKoreaUrl(rawUrl),
      condition: undefined,
      sector: compact([keyword, xmlValue(block, "GI_Part_No")]),
      deadline: formatJobKoreaDate(xmlValue(block, "GI_End_Date") ?? xmlValue(block, "GI_E_Date")),
      sources: ["잡코리아"],
    };

    if (!isTrainingPosting(posting)) jobs.push(posting);
  }

  return jobs;
}

function buildJobKoreaApiUrl(): string {
  const endpoint = config.jobkoreaApiUrl.trim();
  const apiKey = config.jobkoreaApiKey.trim();
  if (endpoint.includes("{API_KEY}")) {
    return endpoint.replaceAll("{API_KEY}", encodeURIComponent(apiKey));
  }

  const url = new URL(endpoint);
  if (!url.searchParams.has("api")) url.searchParams.set("api", apiKey);
  return url.toString();
}

async function decodeJobKoreaResponse(response: Response): Promise<string> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const header = new TextDecoder("ascii").decode(bytes.slice(0, 256));
  const declaredEncoding = header.match(/encoding=["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "";
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const useEucKr = /euc-?kr|ks_c_5601|cp949/.test(`${declaredEncoding} ${contentType}`);

  try {
    return new TextDecoder(useEucKr ? "euc-kr" : "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

async function fetchJobKoreaJobs(field: JobField): Promise<JobPosting[]> {
  if (!hasJobKoreaConfig()) return [];

  const response = await fetch(buildJobKoreaApiUrl(), {
    headers: { Accept: "application/xml,text/xml" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`잡코리아 API HTTP ${response.status}`);
  const xml = await decodeJobKoreaResponse(response);
  if (!/<DataList[\s>]/i.test(xml)) throw new Error("잡코리아 API 응답 형식을 확인할 수 없습니다.");
  return parseJobKoreaList(xml, field);
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
  if (hasJobKoreaConfig()) loaders.push({ source: "잡코리아", load: () => fetchJobKoreaJobs(field) });

  if (loaders.length === 0) {
    if (!warnedMissingSources) {
      console.warn("취업 공고 API 설정이 없습니다. SARAMIN_API_KEY, WORK24_API_KEY 또는 JOBKOREA_API_URL/JOBKOREA_API_KEY를 설정해주세요.");
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
