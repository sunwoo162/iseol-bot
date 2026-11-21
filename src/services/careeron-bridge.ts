import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Contest } from "./contests.js";
import type { JobPosting } from "./job-discovery.js";
import { listActiveItContests } from "./contests.js";
import { withDurableFileStateLock } from "./file-state-lock.js";

const OUTBOX_RETRY_INTERVAL_MS = 15 * 60 * 1000;
const BATCH_SIZE = 25;
const MAX_PENDING = 2000;
const OUTBOX_NAME = "careeron-opportunity-outbox.json";

export function resolveCareerOnOutboxFile(cwd = process.cwd(), configuredPath = process.env.ISEOL_CAREERON_OUTBOX_FILE): string {
  return resolve(configuredPath?.trim() || join(cwd, "data", OUTBOX_NAME));
}

const OUTBOX_FILE = resolveCareerOnOutboxFile();

export type CareerOnPendingContest = {
  sourceId: string;
  contest: Contest | JobPosting;
  firstSeenAt: string;
  attempts: number;
};

export type CareerOnBridgeOptions = {
  endpoint: string;
  secret: string;
  outboxFile?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  listContests?: () => Promise<Contest[]>;
  log?: (message: string) => void;
};

function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Contest source URL must be an HTTPS URL without credentials or a custom port");
  }
  url.hash = "";
  return url.toString();
}

export function careerOnContestSourceId(contest: Pick<Contest, "url">): string {
  return createHash("sha256").update(canonicalUrl(contest.url)).digest("hex");
}

function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("CAREERON_INGEST_URL must be a trusted HTTPS URL");
  }
  return url.toString();
}

async function readOutbox(file: string): Promise<CareerOnPendingContest[]> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!Array.isArray(value)) throw new Error("CareerOn outbox is not an array");
    const sourceIds = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error("CareerOn outbox contains invalid entries; refusing to drop pending contests");
      }
      const pending = item as CareerOnPendingContest;
      const sourceId = typeof pending.sourceId === "string" ? pending.sourceId.toLowerCase() : "";
      if (!/^[a-f0-9]{64}$/.test(sourceId)
        || typeof pending.firstSeenAt !== "string"
        || !Number.isFinite(Date.parse(pending.firstSeenAt))
        || !Number.isInteger(pending.attempts)
        || pending.attempts < 0
        || !pending.contest
        || typeof pending.contest.url !== "string"
        || typeof pending.contest.title !== "string"
        || sourceIds.has(sourceId)) {
        throw new Error("CareerOn outbox contains invalid entries; refusing to drop pending contests");
      }
      sourceIds.add(sourceId);
    }
    return value as CareerOnPendingContest[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeOutbox(file: string, items: CareerOnPendingContest[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(items, null, 2), "utf8");
  await rename(temporary, file);
}

export class CareerOnContestBridge {
  private readonly endpoint: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly listContests: () => Promise<Contest[]>;
  private readonly log: (message: string) => void;
  private running = false;
  private flushing: Promise<{ delivered: number; pending: number }> | null = null;

  constructor(private readonly options: CareerOnBridgeOptions) {
    this.endpoint = validateEndpoint(options.endpoint);
    if (options.secret.trim().length < 32) throw new Error("CAREERON_WEBHOOK_SECRET must be at least 32 characters");
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.listContests = options.listContests ?? listActiveItContests;
    this.log = options.log ?? console.warn;
  }

  private get outboxFile(): string { return this.options.outboxFile ?? OUTBOX_FILE; }

  async enqueue(contests: (Contest | JobPosting)[]): Promise<number> {
    const at = new Date(this.now()).toISOString();
    return withDurableFileStateLock(this.outboxFile, async () => {
      const pending = await readOutbox(this.outboxFile);
      const byId = new Map(pending.map(item => [item.sourceId, item]));
      for (const contest of contests) {
        if (!contest.title?.trim() || !contest.url?.trim()) continue;
        const url = canonicalUrl(contest.url);
        const canonicalContest = { ...contest, url };
        const sourceId = careerOnContestSourceId(canonicalContest);
        const current = byId.get(sourceId);
        byId.set(sourceId, {
          sourceId,
          contest: canonicalContest,
          firstSeenAt: current?.firstSeenAt ?? at,
          attempts: current?.attempts ?? 0,
        });
      }
      const all = [...byId.values()];
      if (all.length > MAX_PENDING) throw new Error("CareerOn outbox is full; refusing to discard pending contests");
      await writeOutbox(this.outboxFile, all);
      return all.length;
    }, { waitForMs: 10_000 });
  }

  async flush(): Promise<{ delivered: number; pending: number }> {
    let delivered = 0;
    const initial = await readOutbox(this.outboxFile);
    for (let offset = 0; offset < initial.length; offset += BATCH_SIZE) {
      const batch = initial.slice(offset, offset + BATCH_SIZE);
      if (!batch.length) continue;
      const timestamp = String(this.now());
      const body = JSON.stringify({
        version: 1,
        syncId: `iseol-${timestamp}-${offset}`,
        checkedAt: Number(timestamp),
        contests: batch.map(item => ({ ...item.contest, kind: "kind" in item.contest ? item.contest.kind : "공모전", sourceId: item.sourceId })),
      });
      const signature = createHmac("sha256", this.options.secret).update(`${timestamp}.${body}`).digest("hex");
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Iseol-Timestamp": timestamp,
            "X-Iseol-Signature": `sha256=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`CareerOn returned HTTP ${response.status}`);
        const sentIds = new Set(batch.map(item => item.sourceId));
        await withDurableFileStateLock(this.outboxFile, async () => {
          const current = await readOutbox(this.outboxFile);
          await writeOutbox(this.outboxFile, current.filter(item => !sentIds.has(item.sourceId)));
        }, { waitForMs: 10_000 });
        delivered += batch.length;
      } catch (error) {
        const failedIds = new Set(batch.map(item => item.sourceId));
        await withDurableFileStateLock(this.outboxFile, async () => {
          const current = await readOutbox(this.outboxFile);
          await writeOutbox(this.outboxFile, current.map(item => failedIds.has(item.sourceId) ? { ...item, attempts: item.attempts + 1 } : item));
        }, { waitForMs: 10_000 });
        this.log(`CareerOn contest delivery failed; ${batch.length} items retained for retry (${error instanceof Error ? error.name : "unknown error"})`);
        break;
      }
    }
    return { delivered, pending: (await readOutbox(this.outboxFile)).length };
  }

  async flushPending(): Promise<{ delivered: number; pending: number }> {
    if (this.flushing) return this.flushing;
    const current = this.flush();
    this.flushing = current;
    try {
      return await current;
    } finally {
      if (this.flushing === current) this.flushing = null;
    }
  }

  async syncSnapshot(contests: Contest[]): Promise<{ discovered: number; delivered: number; pending: number }> {
    try {
      await this.enqueue(contests);
    } catch (error) {
      this.log(`CareerOn contest enqueue failed; flushing existing outbox (${error instanceof Error ? error.name : "unknown error"})`);
    }
    const result = await this.flushPending();
    return { discovered: contests.length, delivered: result.delivered, pending: result.pending };
  }

  async syncJobs(jobs: JobPosting[]): Promise<{ discovered: number; delivered: number; pending: number }> {
    // One signed, durable outbox for both opportunity types.
    await this.enqueue(jobs);
    const result = await this.flushPending();
    return { discovered: jobs.length, ...result };
  }

  async syncOnce(): Promise<{ discovered: number; delivered: number; pending: number }> {
    if (this.running) return { discovered: 0, delivered: 0, pending: (await readOutbox(this.outboxFile)).length };
    this.running = true;
    try {
      let contests: Contest[] = [];
      try { contests = await this.listContests(); }
      catch (error) { this.log(`CareerOn contest discovery failed; flushing existing outbox (${error instanceof Error ? error.name : "unknown error"})`); }
      return await this.syncSnapshot(contests);
    } finally {
      this.running = false;
    }
  }
}

export type CareerOnOpportunitySink = ((contests: Contest[]) => Promise<void>) & { syncJobs: (jobs: JobPosting[]) => Promise<void> };

export function startCareerOnContestBridge(
  rawEndpoint = process.env.CAREERON_INGEST_URL,
  rawSecret = process.env.CAREERON_WEBHOOK_SECRET,
): CareerOnOpportunitySink | null {
  const endpoint = rawEndpoint?.trim();
  const secret = rawSecret?.trim();
  if (!endpoint || !secret) {
    console.log("CareerOn contest bridge disabled (configure CAREERON_INGEST_URL and CAREERON_WEBHOOK_SECRET to enable)");
    return null;
  }
  let bridge: CareerOnContestBridge;
  try { bridge = new CareerOnContestBridge({ endpoint, secret }); }
  catch (error) {
    console.error("CareerOn contest bridge configuration invalid", error instanceof Error ? error.message : "unknown error");
    return null;
  }
  const retry = () => { void bridge.flushPending().catch(error => console.error("CareerOn outbox retry failed", error instanceof Error ? error.message : "unknown error")); };
  retry();
  const timer = setInterval(retry, OUTBOX_RETRY_INTERVAL_MS);
  timer.unref?.();
  const sink = (async (contests: Contest[]) => {
    const result = await bridge.syncSnapshot(contests);
    if (result.discovered || result.delivered || result.pending) console.log(`CareerOn contest sync: discovered=${result.discovered} delivered=${result.delivered} pending=${result.pending}`);
  }) as CareerOnOpportunitySink;
  sink.syncJobs = async (jobs: JobPosting[]) => {
    const result = await bridge.syncJobs(jobs);
    if (result.discovered || result.delivered || result.pending) console.log(`CareerOn job sync: discovered=${result.discovered} delivered=${result.delivered} pending=${result.pending}`);
  };
  return sink;
}
