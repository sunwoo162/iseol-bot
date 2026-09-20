import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertProjectModelId } from "./contracts.js";

export type ProjectWorkRequestStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";
export type ProjectWorkRequest = {
  version: 1;
  id: string;
  projectId: string;
  title: string;
  objective: string;
  nodeId?: string;
  status: ProjectWorkRequestStatus;
  idempotencyKey: string;
  runId?: string;
  attempts: number;
  blocker?: string;
  createdAt: string;
  updatedAt: string;
};

const statuses = new Set<ProjectWorkRequestStatus>(["queued", "running", "waiting", "completed", "failed", "cancelled"]);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function requestFile(root: string, projectId: string, id: string): string {
  assertProjectModelId(projectId);
  if (!idPattern.test(id)) throw new Error(`Invalid work request id: ${id}`);
  return resolve(root, "work-requests", projectId, `${id}.json`);
}

function validate(value: ProjectWorkRequest): void {
  if (value.version !== 1) throw new Error("Unsupported work request version");
  assertProjectModelId(value.id);
  assertProjectModelId(value.projectId);
  if (!value.title.trim() || !value.objective.trim() || !value.idempotencyKey.trim()) throw new Error("Work request title, objective and idempotencyKey are required");
  if (!statuses.has(value.status)) throw new Error(`Invalid work request status: ${value.status}`);
  if (!Number.isInteger(value.attempts) || value.attempts < 0) throw new Error("Invalid work request attempts");
}

export async function saveProjectWorkRequest(root: string, request: ProjectWorkRequest): Promise<void> {
  validate(request);
  const path = requestFile(root, request.projectId, request.id);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(request, null, 2), "utf8");
  await rename(temp, path);
}

export async function loadProjectWorkRequest(root: string, projectId: string, id: string): Promise<ProjectWorkRequest | null> {
  try {
    const request = JSON.parse(await readFile(requestFile(root, projectId, id), "utf8")) as ProjectWorkRequest;
    validate(request);
    return request;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listProjectWorkRequests(root: string, projectId: string): Promise<ProjectWorkRequest[]> {
  const directory = resolve(root, "work-requests", projectId);
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: ProjectWorkRequest[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const request = await loadProjectWorkRequest(root, projectId, name.slice(0, -5));
    if (request) result.push(request);
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function createProjectWorkRequest(input: {
  root: string; projectId: string; title: string; objective: string; idempotencyKey: string; nodeId?: string; at: string; id?: string;
}): Promise<{ request: ProjectWorkRequest; created: boolean }> {
  const existing = (await listProjectWorkRequests(input.root, input.projectId)).find((item) => item.idempotencyKey === input.idempotencyKey);
  if (existing) {
    if (existing.title !== input.title || existing.objective !== input.objective || existing.nodeId !== input.nodeId) throw new Error("work request idempotency conflict");
    return { request: existing, created: false };
  }
  const request: ProjectWorkRequest = {
    version: 1,
    id: input.id ?? `work-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    projectId: input.projectId,
    title: input.title,
    objective: input.objective,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    status: "queued",
    idempotencyKey: input.idempotencyKey,
    attempts: 0,
    createdAt: input.at,
    updatedAt: input.at,
  };
  await saveProjectWorkRequest(input.root, request);
  return { request, created: true };
}

export async function claimProjectWorkRequest(root: string, projectId: string, id: string, at: string): Promise<ProjectWorkRequest | null> {
  const path = requestFile(root, projectId, id);
  const lockPath = `${path}.claim-lock`;
  let handle;
  try { handle = await open(lockPath, "wx"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  try {
    const current = await loadProjectWorkRequest(root, projectId, id);
    if (!current || current.status !== "queued") return null;
    const next = { ...current, status: "running" as const, attempts: current.attempts + 1, updatedAt: at };
    await saveProjectWorkRequest(root, next);
    return next;
  } finally {
    await handle.close();
    const { unlink } = await import("node:fs/promises");
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function updateProjectWorkRequest(root: string, projectId: string, id: string, patch: Partial<Pick<ProjectWorkRequest, "status" | "runId" | "blocker">>, at: string): Promise<ProjectWorkRequest | null> {
  const current = await loadProjectWorkRequest(root, projectId, id);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: at };
  await saveProjectWorkRequest(root, next);
  return next;
}
