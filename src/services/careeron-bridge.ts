import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Contest } from "./contests.js";
import { listActiveItContests } from "./contests.js";
import { withDurableFileStateLock } from "./file-state-lock.js";

const POLL_INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 25;
const MAX_PENDING = 2000;
const OUTBOX_FILE = resolve(process.cwd(), "data", "careeron-opportunity-outbox.json");

export type CareerOnPendingContest = {
  sourceId: string;
  contest: Contest;
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
    return value.filter((item): item is CareerOnPendingContest => Boolean(item)
      && typeof item === "object"
      && typeof (item as CareerOnPendingContest).sourceId === "string"
      && typeof (item as CareerOnPendingContest).firstSeenAt === "string"
      && Number.isInteger((item as CareerOnPendingContest).attempts)
      && typeof (item as CareerOnPendingContest).contest?.url === "string"
      && typeof (item as CareerOnPendingContest).contest?.title === "string");
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

  constructor(private readonly options: CareerOnBridgeOptions) {
    this.endpoint = validateEndpoint(options.endpoint);
    if (options.secret.trim().length < 32) throw new Error("CAREERON_WEBHOOK_SECRET must be at least 32 characters");
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.listContests = options.listContests ?? listActiveItContests;
    this.log = options.log ?? console.warn;
  }

  private get outboxFile(): string { return this.options.outboxFile ?? OUTBOX_FILE; }

  async enqueue(contests: Contest[]): Promise<number> {
    const at = new Date(this.now()).toISOString();
    return withDurableFileStateLock(this.outboxFile, async () => {
      const pending = await readOutbox(this.outboxFile);
      const byId = new Map(pending.map(item => [item.sourceId, item]));
      for (const contest of contests) {
        if (!contest.title?.trim() || !contest.url?.trim()) continue;
        const url = canonicalUrl(contest.url);
        const sourceId = createHash("sha256").update(url).digest("hex");
        const current = byId.get(sourceId);
        byId.set(sourceId, {
          sourceId,
          contest: { ...contest, url },
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
        contests: batch.map(item => ({ ...item.contest, kind: "공모전", sourceId: item.sourceId })),
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

  async syncOnce(): Promise<{ discovered: number; delivered: number; pending: number }> {
    if (this.running) return { discovered: 0, delivered: 0, pending: (await readOutbox(this.outboxFile)).length };
    this.running = true;
    try {
      const contests = await this.listContests();
      const pending = await this.enqueue(contests);
      const result = await this.flush();
      return { discovered: contests.length, delivered: result.delivered, pending: Math.max(0, pending - result.delivered) };
    } finally {
      this.running = false;
    }
  }
}

export function startCareerOnContestBridge(
  rawEndpoint = process.env.CAREERON_INGEST_URL,
  rawSecret = process.env.CAREERON_WEBHOOK_SECRET,
): NodeJS.Timeout | null {
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
  const run = () => { void bridge.syncOnce().then(result => {
    if (result.discovered || result.delivered || result.pending) console.log(`CareerOn contest sync: discovered=${result.discovered} delivered=${result.delivered} pending=${result.pending}`);
  }).catch(error => console.error("CareerOn contest sync failed", error instanceof Error ? error.message : "unknown error")); };
  run();
  const timer = setInterval(run, POLL_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
