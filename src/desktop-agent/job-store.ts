import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DesktopJobResult, DesktopTaskPack } from "./contracts.js";
import { assertDesktopTaskPack } from "./contracts.js";

export type DesktopJobLease = {
  owner: string;
  acquiredAt: string;
  expiresAt: string;
};

export type DesktopJobRecord = {
  version: 1;
  jobId: string;
  runId: string;
  stage: DesktopTaskPack["stage"];
  idempotencyKey: string;
  pack: DesktopTaskPack;
  status: "pending" | "leased" | "indeterminate" | "completed" | "cancelled";
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lease?: DesktopJobLease;
  result?: DesktopJobResult;
};

function assertJobId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`Invalid Desktop Job id: ${id}`);
  }
}

function jobFile(root: string, jobId: string): string {
  assertJobId(jobId);
  return resolve(root, "jobs", jobId, "job.json");
}

async function saveJob(root: string, job: DesktopJobRecord): Promise<void> {
  const path = jobFile(root, job.jobId);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(job, null, 2), "utf8");
  await rename(temp, path);
}

export async function loadDesktopJob(
  root: string,
  jobId: string,
): Promise<DesktopJobRecord | null> {
  const path = jobFile(root, jobId);
  try {
    return JSON.parse(await readFile(path, "utf8")) as DesktopJobRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function semanticTaskIdentity(pack: DesktopTaskPack): string {
  return JSON.stringify({
    runId: pack.runId,
    stage: pack.stage,
    workspaceRoot: pack.workspaceRoot,
    policyDigest: pack.policyDigest ?? null,
    idempotencyKey: pack.idempotencyKey,
    operations: pack.operations,
  });
}

export async function listDesktopJobs(root: string): Promise<DesktopJobRecord[]> {
  const directory = resolve(root, "jobs");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: DesktopJobRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try { assertJobId(entry.name); } catch { continue; }
    const job = await loadDesktopJob(root, entry.name);
    if (job) result.push(job);
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
}

export async function findDesktopJobByIdempotencyKey(
  root: string,
  key: string,
): Promise<DesktopJobRecord | null> {
  const jobs = await listDesktopJobs(root);
  return jobs.find((job) => job.idempotencyKey === key) ?? null;
}

export async function createDesktopJob(
  root: string,
  pack: DesktopTaskPack,
  at: string,
): Promise<DesktopJobRecord> {
  assertDesktopTaskPack(pack);
  const existingByKey = await findDesktopJobByIdempotencyKey(root, pack.idempotencyKey);
  if (existingByKey) {
    if (semanticTaskIdentity(existingByKey.pack) !== semanticTaskIdentity(pack)) {
      throw new Error(`Desktop Job idempotency conflict: ${pack.idempotencyKey}`);
    }
    return existingByKey;
  }
  const existingById = await loadDesktopJob(root, pack.jobId);
  if (existingById) throw new Error(`Desktop Job already exists: ${pack.jobId}`);
  const job: DesktopJobRecord = {
    version: 1,
    jobId: pack.jobId,
    runId: pack.runId,
    stage: pack.stage,
    idempotencyKey: pack.idempotencyKey,
    pack: structuredClone(pack),
    status: "pending",
    attempts: 0,
    createdAt: at,
    updatedAt: at,
  };
  await saveJob(root, job);
  return job;
}

function validateLeaseDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`Desktop Job lease duration must be positive: ${durationMs}`);
  }
}

export async function acquireDesktopJobLease(
  root: string,
  jobId: string,
  owner: string,
  now: string,
  durationMs: number,
): Promise<DesktopJobRecord> {
  validateLeaseDuration(durationMs);
  const job = await loadDesktopJob(root, jobId);
  if (!job) throw new Error(`Desktop Job not found: ${jobId}`);
  if (job.status === "completed" || job.status === "cancelled") {
    throw new Error(`Desktop Job is terminal: ${jobId}`);
  }
  const leaseLive = job.lease && Date.parse(job.lease.expiresAt) > Date.parse(now);
  if (leaseLive && job.lease?.owner !== owner) {
    throw new Error(`Desktop Job has an active lease owned by ${job.lease?.owner}`);
  }
  if (leaseLive && job.lease?.owner === owner) return job;
  const next: DesktopJobRecord = {
    ...job,
    status: "leased",
    attempts: job.attempts + 1,
    lease: {
      owner,
      acquiredAt: now,
      expiresAt: new Date(Date.parse(now) + durationMs).toISOString(),
    },
    updatedAt: now,
  };
  await saveJob(root, next);
  return next;
}

export async function renewDesktopJobLease(
  root: string,
  jobId: string,
  owner: string,
  now: string,
  durationMs: number,
): Promise<DesktopJobRecord> {
  validateLeaseDuration(durationMs);
  const job = await loadDesktopJob(root, jobId);
  if (!job) throw new Error(`Desktop Job not found: ${jobId}`);
  if (!job.lease || job.lease.owner !== owner) {
    throw new Error(`Desktop Job lease owner mismatch: ${jobId}`);
  }
  if (Date.parse(job.lease.expiresAt) <= Date.parse(now)) {
    throw new Error(`Desktop Job lease expired: ${jobId}`);
  }
  const next: DesktopJobRecord = {
    ...job,
    lease: { ...job.lease, expiresAt: new Date(Date.parse(now) + durationMs).toISOString() },
    updatedAt: now,
  };
  await saveJob(root, next);
  return next;
}

export async function completeDesktopJob(
  root: string,
  jobId: string,
  owner: string,
  result: DesktopJobResult,
): Promise<DesktopJobRecord> {
  const job = await loadDesktopJob(root, jobId);
  if (!job) throw new Error(`Desktop Job not found: ${jobId}`);
  if (job.status === "completed") {
    if (JSON.stringify(job.result) === JSON.stringify(result)) return job;
    throw new Error(`Desktop completed job is immutable: ${jobId}`);
  }
  if (job.status === "cancelled") throw new Error(`Desktop Job is cancelled: ${jobId}`);
  if (!job.lease || job.lease.owner !== owner) {
    throw new Error(`Desktop Job lease owner mismatch: ${jobId}`);
  }
  const next: DesktopJobRecord = {
    ...job,
    status: "completed",
    result: structuredClone(result),
    updatedAt: result.completedAt,
  };
  await saveJob(root, next);
  return next;
}

export async function markDesktopJobIndeterminate(
  root: string,
  jobId: string,
  owner: string,
  at: string,
): Promise<DesktopJobRecord> {
  const job = await loadDesktopJob(root, jobId);
  if (!job) throw new Error(`Desktop Job not found: ${jobId}`);
  if (job.status === "completed" || job.status === "cancelled") {
    throw new Error(`Desktop Job is terminal: ${jobId}`);
  }
  if (!job.lease || job.lease.owner !== owner) {
    throw new Error(`Desktop Job lease owner mismatch: ${jobId}`);
  }
  const next: DesktopJobRecord = { ...job, status: "indeterminate", updatedAt: at };
  await saveJob(root, next);
  return next;
}

export async function requeueDesktopJob(
  root: string,
  jobId: string,
  owner: string,
  at: string,
): Promise<DesktopJobRecord> {
  const job = await loadDesktopJob(root, jobId);
  if (!job) throw new Error(`Desktop Job not found: ${jobId}`);
  if (job.status === "completed" || job.status === "cancelled") {
    throw new Error(`Desktop Job is terminal: ${jobId}`);
  }
  if (!job.lease || job.lease.owner !== owner) {
    throw new Error(`Desktop Job lease owner mismatch: ${jobId}`);
  }
  const { lease: _lease, result: _result, ...rest } = job;
  const next: DesktopJobRecord = { ...rest, status: "pending", updatedAt: at };
  await saveJob(root, next);
  return next;
}

export async function listRecoverableDesktopJobs(
  root: string,
  now: string,
): Promise<DesktopJobRecord[]> {
  const nowMs = Date.parse(now);
  const jobs = await listDesktopJobs(root);
  return jobs.filter((job) => {
    if (job.status === "completed" || job.status === "cancelled") return false;
    if (!job.lease) return true;
    return Date.parse(job.lease.expiresAt) <= nowMs;
  });
}
