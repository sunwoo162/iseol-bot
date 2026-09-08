import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { EvaluationObservation } from "./contracts.js";
import { assertEvaluationId, assertEvaluationObservation } from "./contracts.js";
import { evaluationDirectory } from "./store-utils.js";

function observationFile(root: string, evaluationId: string): string {
  assertEvaluationId(evaluationId);
  return resolve(evaluationDirectory(root, "observations"), `${evaluationId}.jsonl`);
}

export async function listEvaluationObservations(root: string, evaluationId: string): Promise<EvaluationObservation[]> {
  const path = observationFile(root, evaluationId);
  try {
    const content = await readFile(path, "utf8");
    return content.split(/\r?\n/).filter(Boolean).map((line) => {
      const item = JSON.parse(line) as EvaluationObservation;
      assertEvaluationObservation(item);
      return item;
    });
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export async function appendEvaluationObservationOnce(root: string, observation: EvaluationObservation): Promise<boolean> {
  assertEvaluationObservation(observation);
  const existing = (await listEvaluationObservations(root, observation.evaluationId)).find((item) => item.id === observation.id);
  if (existing) {
    const sameIdentity = existing.evaluationId === observation.evaluationId && existing.scenarioId === observation.scenarioId && existing.type === observation.type && existing.summary === observation.summary && existing.reference === observation.reference;
    if (!sameIdentity) throw new Error(`Evaluation observation identity mismatch: ${observation.id}`);
    return false;
  }
  const path = observationFile(root, observation.evaluationId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(observation)}\n`, "utf8");
  return true;
}
