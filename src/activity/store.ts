import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { assertIdentityId } from "../identity/contracts.js";
import type { ActivityEvent } from "./contracts.js";

function eventDirectory(root: string, userId: string): string {
  assertIdentityId(userId);
  return resolve(root, "users", userId, "activity", "events");
}

function eventPath(root: string, userId: string, eventId: string): string {
  assertIdentityId(eventId);
  return resolve(eventDirectory(root, userId), `${eventId}.json`);
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, path);
}

export async function saveActivityEvent(root: string, event: ActivityEvent): Promise<void> {
  await saveJson(eventPath(root, event.userId, event.id), event);
}

export async function loadActivityEvent(root: string, userId: string, eventId: string): Promise<ActivityEvent | null> {
  try { return JSON.parse(await readFile(eventPath(root, userId, eventId), "utf8")) as ActivityEvent; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function listActivityEvents(root: string, userId: string): Promise<ActivityEvent[]> {
  const directory = eventDirectory(root, userId);
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: ActivityEvent[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    try { events.push(JSON.parse(await readFile(resolve(directory, name), "utf8")) as ActivityEvent); } catch { /* fail closed for malformed evidence */ }
  }
  return events;
}
