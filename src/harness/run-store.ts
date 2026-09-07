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

function normalizeHarnessRunEnvelope(
  envelope: HarnessRunEnvelope,
): HarnessRuntimeRunEnvelope {
  return {
    ...envelope,
    state: envelope.state ?? createInitialRunState(envelope.preflight, envelope.updatedAt),
    evidence: envelope.evidence ?? [],
  };
}export async function saveHarnessRun(
  root: string,
  envelope: HarnessRunEnvelope,
): Promise<void> {
  const normalized = normalizeHarnessRunEnvelope(envelope);
  const destination = runFile(root, normalized.request.runId);
  const directory = resolve(root, normalized.request.runId);
  await mkdir(directory, { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(normalized, null, 2), "utf8");
  await rename(temporary, destination);
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