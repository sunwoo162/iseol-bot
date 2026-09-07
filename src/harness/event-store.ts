import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type {
  HarnessCheckpoint,
  HarnessRunEvent,
} from "./contracts.js";
import { assertSafeRunId } from "./run-store.js";

function runDirectory(root: string, runId: string): string {
  assertSafeRunId(runId);
  return resolve(root, runId);
}

export async function appendHarnessRunEvent(
  root: string,
  event: HarnessRunEvent,
): Promise<void> {
  const directory = runDirectory(root, event.runId);
  await mkdir(directory, { recursive: true });
  await appendFile(resolve(directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
}export async function loadHarnessRunEvents(
  root: string,
  runId: string,
): Promise<HarnessRunEvent[]> {
  const path = resolve(runDirectory(root, runId), "events.jsonl");
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as HarnessRunEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveHarnessCheckpoint(
  root: string,
  checkpoint: HarnessCheckpoint,
): Promise<void> {
  const directory = resolve(runDirectory(root, checkpoint.runId), "checkpoints");
  await mkdir(directory, { recursive: true });
  const filename = `${checkpoint.recordedAt.replace(/[:.]/g, "-")}--${checkpoint.id}.json`;
  const destination = resolve(directory, filename);
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(checkpoint, null, 2), "utf8");
  await rename(temporary, destination);
}export async function loadLatestHarnessCheckpoint(
  root: string,
  runId: string,
): Promise<HarnessCheckpoint | null> {
  const directory = resolve(runDirectory(root, runId), "checkpoints");
  try {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const checkpoints = await Promise.all(files.map(async (name) => {
      const content = await readFile(resolve(directory, name), "utf8");
      return JSON.parse(content) as HarnessCheckpoint;
    }));
    checkpoints.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    return checkpoints.at(-1) ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}