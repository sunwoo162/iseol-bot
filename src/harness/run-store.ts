import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  HarnessRunEnvelope,
  HarnessRuntimeRunEnvelope,
} from "./contracts.js";
import { createInitialRunState } from "./state-machine.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function assertSafeRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid Iseol Run id: ${runId}`);
  }
}

function runFile(root: string, runId: string): string {
  assertSafeRunId(runId);
  return resolve(root, runId, "run.json");
}

const runWriteQueues = new Map<string, Promise<unknown>>();

async function serializeRunWrite<T>(root: string, runId: string, action: () => Promise<T>): Promise<T> {
  const key = runFile(root, runId);
  const previous = runWriteQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(action);
  runWriteQueues.set(key, current);
  try { return await current; }
  finally { if (runWriteQueues.get(key) === current) runWriteQueues.delete(key); }
}

function normalizeHarnessRunEnvelope(
  envelope: HarnessRunEnvelope,
): HarnessRuntimeRunEnvelope {
  return {
    ...envelope,
    state: envelope.state ?? createInitialRunState(envelope.preflight, envelope.updatedAt),
    evidence: envelope.evidence ?? [],
  };
}

async function writeNormalizedRun(root: string, normalized: HarnessRuntimeRunEnvelope): Promise<void> {
  const destination = runFile(root, normalized.request.runId);
  const directory = resolve(root, normalized.request.runId);
  await mkdir(directory, { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(normalized, null, 2), "utf8");
  await rename(temporary, destination);
}

export async function saveHarnessRun(root: string, envelope: HarnessRunEnvelope): Promise<void> {
  const normalized = normalizeHarnessRunEnvelope(envelope);
  await serializeRunWrite(root, normalized.request.runId, () => writeNormalizedRun(root, normalized));
}

export async function loadHarnessRun(
  root: string,
  runId: string,
): Promise<HarnessRuntimeRunEnvelope | null> {
  const path = runFile(root, runId);
  try {
    const content = await readFile(path, "utf8");
    return normalizeHarnessRunEnvelope(JSON.parse(content) as HarnessRunEnvelope);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveHarnessRunIfUnchanged(
  root: string,
  expected: HarnessRunEnvelope,
  next: HarnessRunEnvelope,
): Promise<boolean> {
  const expectedRun = normalizeHarnessRunEnvelope(expected);
  const nextRun = normalizeHarnessRunEnvelope(next);
  if (expectedRun.request.runId !== nextRun.request.runId) {
    throw new Error("Harness Run compare-and-save runId mismatch");
  }
  return serializeRunWrite(root, expectedRun.request.runId, async () => {
    const current = await loadHarnessRun(root, expectedRun.request.runId);
    if (!current || JSON.stringify(current) !== JSON.stringify(expectedRun)) return false;
    await writeNormalizedRun(root, nextRun);
    return true;
  });
}
