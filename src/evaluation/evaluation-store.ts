import { resolve } from "node:path";
import type { EvaluationRun } from "./contracts.js";
import { assertEvaluationId, assertEvaluationRun } from "./contracts.js";
import { evaluationDirectory, listEvaluationJsonFiles, readEvaluationJson, writeEvaluationJsonAtomic } from "./store-utils.js";

function runFile(root: string, id: string): string {
  assertEvaluationId(id);
  return resolve(evaluationDirectory(root, "runs"), `${id}.json`);
}
export async function saveEvaluationRun(root: string, run: EvaluationRun): Promise<void> {
  assertEvaluationRun(run);
  await writeEvaluationJsonAtomic(runFile(root, run.evaluationId), run);
}
export async function loadEvaluationRun(root: string, id: string): Promise<EvaluationRun | null> {
  const value = await readEvaluationJson<EvaluationRun>(runFile(root, id));
  if (value) assertEvaluationRun(value);
  return value;
}
export async function listEvaluationRuns(root: string): Promise<EvaluationRun[]> {
  const result: EvaluationRun[] = [];
  for (const name of await listEvaluationJsonFiles(evaluationDirectory(root, "runs"))) {
    const value = await loadEvaluationRun(root, name.slice(0, -5));
    if (value) result.push(value);
  }
  return result.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.evaluationId.localeCompare(b.evaluationId));
}
