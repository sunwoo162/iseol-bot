import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertIdentityId, assertTimestamp } from "../identity/contracts.js";
import type { AiTeamDiscussion } from "./contracts.js";

function file(root: string, projectId: string, discussionId: string): string { assertIdentityId(projectId); assertIdentityId(discussionId); return resolve(root, "discussions", projectId, `${discussionId}.json`); }
function validate(value: AiTeamDiscussion): void {
  if (value.version !== 1) throw new Error("Unsupported AI team discussion version");
  assertIdentityId(value.id); assertIdentityId(value.projectId); assertIdentityId(value.teamId); assertIdentityId(value.agentId);
  if (!value.requestId.trim() || !value.question.trim()) throw new Error("AI team discussion fields are required");
  if (!["waiting-runtime", "completed"].includes(value.status)) throw new Error("Invalid AI team discussion status");
  if (value.question.length > 4_000 || (value.answer && value.answer.length > 10_000)) throw new Error("AI team discussion text is invalid");
  for (const values of [value.keyPoints, value.alternatives, value.risks]) {
    if (values.length > 8 || values.some((item) => !item.trim() || item.length > 500)) throw new Error("AI team discussion list is invalid");
  }
  if (value.status === "completed" && !value.answer?.trim()) throw new Error("Completed AI team discussion answer is required");
  assertTimestamp(value.createdAt, "AI team discussion createdAt"); assertTimestamp(value.updatedAt, "AI team discussion updatedAt");
}
async function loadAt(path: string): Promise<AiTeamDiscussion | null> { try { const value = JSON.parse(await readFile(path, "utf8")) as AiTeamDiscussion; validate(value); return value; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; } }
export async function saveAiTeamDiscussion(root: string, discussion: AiTeamDiscussion): Promise<void> { validate(discussion); const path = file(root, discussion.projectId, discussion.id); await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(discussion, null, 2), "utf8"); await rename(temp, path); }
export async function loadAiTeamDiscussion(root: string, projectId: string, discussionId: string): Promise<AiTeamDiscussion | null> { return loadAt(file(root, projectId, discussionId)); }
export async function listAiTeamDiscussions(root: string, projectId: string): Promise<AiTeamDiscussion[]> {
  assertIdentityId(projectId); let names: string[]; try { names = await readdir(resolve(root, "discussions", projectId)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: AiTeamDiscussion[] = []; for (const name of names.filter((item) => item.endsWith(".json"))) { const value = await loadAt(resolve(root, "discussions", projectId, name)); if (value) result.push(value); }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
