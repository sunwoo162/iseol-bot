import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProjectHistoryEvent } from "./contracts.js";
import { assertProjectModelId } from "./contracts.js";

function historyFile(root: string, projectId: string): string {
  assertProjectModelId(projectId);
  return resolve(root, "projects", projectId, "history.jsonl");
}

export async function appendProjectHistoryEvent(
  root: string,
  event: ProjectHistoryEvent,
): Promise<void> {
  assertProjectModelId(event.projectId);
  const path = historyFile(root, event.projectId);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export async function loadProjectHistory(
  root: string,
  projectId: string,
): Promise<ProjectHistoryEvent[]> {
  const path = historyFile(root, projectId);
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ProjectHistoryEvent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendProjectHistoryEventOnce(
  root: string,
  event: ProjectHistoryEvent,
): Promise<boolean> {
  const existing = (await loadProjectHistory(root, event.projectId))
    .find((item) => item.id === event.id);
  if (existing) {
    const sameIdentity = existing.projectId === event.projectId
      && existing.type === event.type
      && existing.prototypeId === event.prototypeId
      && existing.nodeId === event.nodeId
      && existing.runId === event.runId
      && existing.source === event.source
      && existing.action === event.action
      && existing.reference === event.reference
      && existing.occurredAt === event.occurredAt
      && existing.lifecycle === event.lifecycle;
    if (!sameIdentity) {
      throw new Error(`Project history event identity mismatch: ${event.id}`);
    }
    return false;
  }
  await appendProjectHistoryEvent(root, event);
  return true;
}
