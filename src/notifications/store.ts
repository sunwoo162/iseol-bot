import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertIdentityId } from "../identity/contracts.js";
import type { NotificationStreamEvent, UserNotification } from "./contracts.js";

function notificationDirectory(root: string, userId: string): string {
  assertIdentityId(userId);
  return resolve(root, "notifications", "users", userId);
}

function notificationPath(root: string, userId: string, notificationId: string): string {
  assertIdentityId(notificationId);
  return resolve(notificationDirectory(root, userId), `${notificationId}.json`);
}

function streamEventDirectory(root: string, userId: string): string {
  assertIdentityId(userId);
  return resolve(notificationDirectory(root, userId), "stream-events");
}

function streamEventPath(root: string, userId: string, eventId: string): string {
  assertIdentityId(eventId);
  return resolve(streamEventDirectory(root, userId), `${eventId}.json`);
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, path);
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveNotification(root: string, value: UserNotification): Promise<void> {
  await saveJson(notificationPath(root, value.userId, value.id), value);
}

export async function loadNotification(root: string, userId: string, notificationId: string): Promise<UserNotification | null> {
  return loadJson<UserNotification>(notificationPath(root, userId, notificationId));
}

export async function listNotifications(root: string, userId: string): Promise<UserNotification[]> {
  const directory = notificationDirectory(root, userId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: UserNotification[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const value = await loadJson<UserNotification>(resolve(directory, name));
    if (value) result.push(value);
  }
  return result;
}

export async function saveStreamEvent(root: string, userId: string, value: NotificationStreamEvent): Promise<void> {
  await saveJson(streamEventPath(root, userId, value.id), value);
}

export async function listStreamEvents(root: string, userId: string, afterEventId?: string): Promise<NotificationStreamEvent[]> {
  assertIdentityId(userId);
  if (afterEventId !== undefined) assertIdentityId(afterEventId);
  const directory = streamEventDirectory(root, userId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: NotificationStreamEvent[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const value = await loadJson<NotificationStreamEvent>(resolve(directory, name));
    if (value) result.push(value);
  }
  result.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  if (!afterEventId) return result;
  const cursor = result.findIndex((event) => event.id === afterEventId);
  return cursor < 0 ? [] : result.slice(cursor + 1);
}
