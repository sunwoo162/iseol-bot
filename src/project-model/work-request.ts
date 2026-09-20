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
  dependencies?: string[];
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
  if (value.dependencies) {
    if (new Set(value.dependencies).size !== value.dependencies.length || value.dependencies.some((id) => !idPattern.test(id) || id === value.id)) {
      throw new Error("Invalid work request dependencies");
    }
  }
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
  root: string; projectId: string; title: string; objective: string; idempotencyKey: string; nodeId?: string; dependencies?: string[]; at: string; id?: string;
}): Promise<{ request: ProjectWorkRequest; created: boolean }> {
  const dependencies = input.dependencies ?? [];
  if (new Set(dependencies).size !== dependencies.length || dependencies.includes(input.id ?? "")) throw new Error("invalid work request dependency graph");
  if (dependencies.length) {
    const knownIds = new Set((await listProjectWorkRequests(input.root, input.projectId)).map((item) => item.id));
    const missing = dependencies.filter((dependency) => !knownIds.has(dependency));
    if (missing.length) throw new Error(`unknown work request dependency: ${missing.join(", ")}`);
  }
  const existing = (await listProjectWorkRequests(input.root, input.projectId)).find((item) => item.idempotencyKey === input.idempotencyKey);
  if (existing) {
    if (existing.title !== input.title || existing.objective !== input.objective || existing.nodeId !== input.nodeId || JSON.stringify(existing.dependencies ?? []) !== JSON.stringify(input.dependencies ?? [])) throw new Error("work request idempotency conflict");
    return { request: existing, created: false };
  }
  const request: ProjectWorkRequest = {
    version: 1,
    id: input.id ?? `work-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`,
    projectId: input.projectId,
    title: input.title,
    objective: input.objective,
    ...(input.nodeId ? { nodeId: input.nodeId } : {}),
    ...(dependencies.length ? { dependencies: [...dependencies] } : {}),
    status: "queued",
    idempotencyKey: input.idempotencyKey,
    attempts: 0,
    createdAt: input.at,
    updatedAt: input.at,
  };
  await saveProjectWorkRequest(input.root, request);
  return { request, created: true };
}

export type ProjectWorkRequestExecutionResult = {
  status: "started" | "already-active" | "waiting" | "failed" | "in-progress" | "not-claimable";
  request: ProjectWorkRequest | null;
  runId?: string;
  blocker?: string;
};

export async function executeProjectWorkRequest(input: {
  root: string;
  projectId: string;
  id: string;
  at: string;
  execute: (request: ProjectWorkRequest) => Promise<{ runId: string; status: "created" | "already-active" | "not-configured" }>;
}): Promise<ProjectWorkRequestExecutionResult> {
  const current = await loadProjectWorkRequest(input.root, input.projectId, input.id);
  if (!current) return { status: "not-claimable", request: null, blocker: "work request not found" };
  if (current.status === "running" && current.runId) return { status: "in-progress", request: current, runId: current.runId };
  if (current.status !== "queued") return { status: "not-claimable", request: current, blocker: `request is ${current.status}` };
  const dependencies = current.dependencies ?? [];
  if (dependencies.length) {
    const requests = await listProjectWorkRequests(input.root, input.projectId);
    const byId = new Map(requests.map((item) => [item.id, item]));
    const missing = dependencies.filter((dependency) => byId.get(dependency)?.status !== "completed");
    if (missing.length) return { status: "waiting", request: current, blocker: `dependencies incomplete: ${missing.join(", ")}` };
  }
  const claimed = await claimProjectWorkRequest(input.root, input.projectId, input.id, input.at);
  if (!claimed) return { status: "not-claimable", request: await loadProjectWorkRequest(input.root, input.projectId, input.id), blocker: "request was claimed by another worker or is no longer queued" };
  try {
    const execution = await input.execute(claimed);
    const nextStatus = execution.status === "not-configured" ? "waiting" : "running";
    const updated = await updateProjectWorkRequest(input.root, input.projectId, input.id, {
      status: nextStatus,
      runId: execution.runId,
      ...(execution.status === "not-configured" ? { blocker: "Project Runtime is not configured" } : {}),
    }, input.at);
    return { status: execution.status === "not-configured" ? "waiting" : execution.status === "created" ? "started" : "already-active", request: updated ?? claimed, runId: execution.runId, ...(execution.status === "not-configured" ? { blocker: "Project Runtime is not configured" } : {}) };
  } catch (error) {
    const blocker = error instanceof Error ? error.message.slice(0, 240) : "work request execution failed";
    const updated = await updateProjectWorkRequest(input.root, input.projectId, input.id, { status: "failed", blocker }, input.at);
    return { status: "failed", request: updated ?? claimed, blocker };
  }
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
