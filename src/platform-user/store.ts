import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { assertIdentityId } from "../identity/contracts.js";
import type { PlatformUserRecord } from "./contracts.js";

function profilePath(root: string, userId: string): string {
  assertIdentityId(userId);
  return resolve(root, "users", userId, "profile.json");
}

function credentialPath(root: string, userId: string): string {
  assertIdentityId(userId);
  return resolve(root, "users", userId, "credentials.json");
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, path);
}

export async function savePlatformUser(root: string, user: PlatformUserRecord): Promise<void> {
  await saveJson(profilePath(root, user.id), user);
}

export async function loadPlatformUser(root: string, userId: string): Promise<PlatformUserRecord | null> {
  try {
    return JSON.parse(await readFile(profilePath(root, userId), "utf8")) as PlatformUserRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export type PasswordCredential = { version: 1; salt: string; hash: string; createdAt: string };

export async function savePasswordCredential(root: string, userId: string, credential: PasswordCredential): Promise<void> {
  await saveJson(credentialPath(root, userId), credential);
}

export async function loadPasswordCredential(root: string, userId: string): Promise<PasswordCredential | null> {
  try {
    return JSON.parse(await readFile(credentialPath(root, userId), "utf8")) as PasswordCredential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listPlatformUsers(root: string): Promise<PlatformUserRecord[]> {
  let entries: string[];
  try { entries = await readdir(resolve(root, "users")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const users: PlatformUserRecord[] = [];
  for (const entry of entries) {
    try {
      const user = await loadPlatformUser(root, entry);
      if (user) users.push(user);
    } catch {
      // Invalid or partial user records are not exposed by lookup.
    }
  }
  return users;
}
