import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { assertIdentityId } from "../identity/contracts.js";
import type { UserSettings } from "./contracts.js";
import { renameWithTransientRetry, type AtomicRenameDependencies } from "../desktop-agent/atomic-file.js";

function settingsPath(root: string, userId: string): string {
  assertIdentityId(userId);
  return resolve(root, "users", userId, "settings.json");
}

async function saveJson(path: string, value: unknown, renameDeps?: AtomicRenameDependencies): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await renameWithTransientRetry(temporary, path, renameDeps);
}

export async function saveSettings(root: string, settings: UserSettings, renameDeps?: AtomicRenameDependencies): Promise<void> {
  await saveJson(settingsPath(root, settings.userId), settings, renameDeps);
}

export async function loadSettings(root: string, userId: string): Promise<UserSettings | null> {
  try {
    return JSON.parse(await readFile(settingsPath(root, userId), "utf8")) as UserSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
