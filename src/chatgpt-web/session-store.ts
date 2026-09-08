import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { HarnessRunStage } from "../harness/contracts.js";
import type { WebWorkerSession } from "./contracts.js";
import { assertWebWorkerSession } from "./contracts.js";

const writeQueues = new Map<string, Promise<unknown>>();

function safeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}
function sessionFile(root: string, sessionId: string): string {
  return resolve(root, "web-workers", "sessions", `${safeId(sessionId, "sessionId")}.json`);
}
function activeFile(root: string, runId: string, stage: HarnessRunStage): string {
  return resolve(root, "web-workers", "runs", safeId(runId, "runId"), "stages", stage, "active-session.json");
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, path);
}
async function serialized<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(action);
  writeQueues.set(key, run);
  try { return await run; }
  finally { if (writeQueues.get(key) === run) writeQueues.delete(key); }
}

export async function loadWebWorkerSession(root: string, sessionId: string): Promise<WebWorkerSession | null> {
  try {
    const value = JSON.parse(await readFile(sessionFile(root, sessionId), "utf8"));
    assertWebWorkerSession(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function getActiveWebWorkerSession(root: string, runId: string, stage: HarnessRunStage): Promise<WebWorkerSession | null> {
  try {
    const pointer = JSON.parse(await readFile(activeFile(root, runId, stage), "utf8")) as { sessionId?: string };
    if (!pointer.sessionId) throw new Error("Active Web worker session pointer is invalid");
    const session = await loadWebWorkerSession(root, pointer.sessionId);
    return session && session.status !== "lost" && session.status !== "closed" ? session : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export async function createWebWorkerSession(root: string, session: WebWorkerSession): Promise<WebWorkerSession> {
  assertWebWorkerSession(session);
  const key = activeFile(root, session.runId, session.stage);
  return serialized(key, async () => {
    const existingById = await loadWebWorkerSession(root, session.sessionId);
    if (existingById) {
      if (JSON.stringify(existingById) !== JSON.stringify(session)) throw new Error(`Web worker session identity conflict: ${session.sessionId}`);
      return existingById;
    }
    const active = await getActiveWebWorkerSession(root, session.runId, session.stage);
    if (active) throw new Error(`Web worker active session already exists: ${active.sessionId}`);
    await atomicJson(sessionFile(root, session.sessionId), session);
    await atomicJson(key, { version: 1, sessionId: session.sessionId, generation: session.generation });
    return structuredClone(session);
  });
}

export async function replaceLostWebWorkerSession(
  root: string,
  currentSessionId: string,
  replacement: WebWorkerSession,
  at: string,
): Promise<WebWorkerSession> {
  assertWebWorkerSession(replacement);
  const current = await loadWebWorkerSession(root, currentSessionId);
  if (!current) throw new Error(`Web worker session not found: ${currentSessionId}`);
  const key = activeFile(root, current.runId, current.stage);
  return serialized(key, async () => {
    const latest = await loadWebWorkerSession(root, currentSessionId);
    if (!latest) throw new Error(`Web worker session not found: ${currentSessionId}`);
    if (replacement.runId !== latest.runId || replacement.stage !== latest.stage) throw new Error("Replacement session run/stage mismatch");
    if (replacement.generation !== latest.generation + 1) throw new Error("Replacement session generation must increment by one");
    if (replacement.policySha256 !== latest.policySha256) throw new Error("Replacement session policySha256 mismatch");
    const lost: WebWorkerSession = { ...latest, status: "lost", closedAt: at };
    await atomicJson(sessionFile(root, latest.sessionId), lost);
    await atomicJson(sessionFile(root, replacement.sessionId), replacement);
    await atomicJson(key, { version: 1, sessionId: replacement.sessionId, generation: replacement.generation });
    return structuredClone(replacement);
  });
}
