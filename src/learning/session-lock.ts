import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertIdentityId } from "../identity/contracts.js";

type SessionLockRecord = { version: 1; pid: number; token: string; createdAt: string };

function lockPath(root: string, userId: string, sessionId: string): string {
  assertIdentityId(userId);
  assertIdentityId(sessionId);
  return resolve(root, "users", userId, "learning", "session-locks", `${sessionId}.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeDeadOwnerLock(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<SessionLockRecord>;
    const pid = value.pid;
    if (value.version !== 1 || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof value.token !== "string" || !value.token) return false;
    if (processIsAlive(pid)) return false;
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

export async function withDurableLearningSessionLock<T>(
  root: string,
  userId: string,
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const path = lockPath(root, userId, sessionId);
  await mkdir(dirname(path), { recursive: true });
  let handle: FileHandle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await removeDeadOwnerLock(path))) throw new Error("Learning session revision conflict");
    try { handle = await open(path, "wx"); }
    catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Learning session revision conflict");
      throw retryError;
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() } satisfies SessionLockRecord), "utf8");
    return await task();
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
  }
}
