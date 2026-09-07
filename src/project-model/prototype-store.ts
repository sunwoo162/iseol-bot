import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { PrototypeCandidate } from "./contracts.js";
import { assertProjectModelId } from "./contracts.js";

function prototypeFile(root: string, id: string): string {
  assertProjectModelId(id);
  return resolve(root, "prototypes", `${id}.json`);
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, path);
}

export async function savePrototypeCandidate(
  root: string,
  candidate: PrototypeCandidate,
): Promise<void> {
  assertProjectModelId(candidate.id);
  await writeAtomic(prototypeFile(root, candidate.id), candidate);
}

export async function loadPrototypeCandidate(
  root: string,
  id: string,
): Promise<PrototypeCandidate | null> {
  const path = prototypeFile(root, id);
  try {
    return JSON.parse(await readFile(path, "utf8")) as PrototypeCandidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function updatePrototypeCandidate(
  root: string,
  id: string,
  updates: Partial<Omit<PrototypeCandidate, "id" | "version">>,
): Promise<PrototypeCandidate | null> {
  const current = await loadPrototypeCandidate(root, id);
  if (!current) return null;
  const updated: PrototypeCandidate = { ...current, ...updates, id, version: 1 };
  await savePrototypeCandidate(root, updated);
  return updated;
}
