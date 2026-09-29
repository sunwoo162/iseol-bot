import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertIdentityId } from "../identity/contracts.js";
import type { CurriculumLink, StudySpace, StudyTask, StudyTaskSubmission } from "./contracts.js";
import { withDurableStudySubmissionLock } from "./submission-lock.js";

function studyPath(root: string, studySpaceId: string): string { assertIdentityId(studySpaceId); return resolve(root, "studies", studySpaceId, "study.json"); }
function linkPath(root: string, studySpaceId: string, linkId: string): string { assertIdentityId(studySpaceId); assertIdentityId(linkId); return resolve(root, "studies", studySpaceId, "curriculum-links", `${linkId}.json`); }
function taskPath(root: string, studySpaceId: string, taskId: string): string { assertIdentityId(studySpaceId); assertIdentityId(taskId); return resolve(root, "studies", studySpaceId, "tasks", `${taskId}.json`); }
function submissionPath(root: string, studySpaceId: string, taskId: string, userId: string): string { assertIdentityId(studySpaceId); assertIdentityId(taskId); assertIdentityId(userId); return resolve(root, "studies", studySpaceId, "tasks", taskId, "submissions", `${userId}.json`); }

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, path);
}
async function loadJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function listJson<T>(directory: string): Promise<T[]> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: T[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const value = await loadJson<T>(resolve(directory, name));
    if (value) result.push(value);
  }
  return result;
}

export const saveStudySpace = (root: string, value: StudySpace) => saveJson(studyPath(root, value.id), value);
export const loadStudySpace = (root: string, studySpaceId: string) => loadJson<StudySpace>(studyPath(root, studySpaceId));
export async function listStudySpaces(root: string): Promise<StudySpace[]> {
  let names: string[];
  try { names = await readdir(resolve(root, "studies")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: StudySpace[] = [];
  for (const name of names) { const value = await loadJson<StudySpace>(resolve(root, "studies", name, "study.json")); if (value) result.push(value); }
  return result;
}
export const saveCurriculumLink = (root: string, value: CurriculumLink) => saveJson(linkPath(root, value.studySpaceId, value.id), value);
export const listCurriculumLinks = (root: string, studySpaceId: string) => listJson<CurriculumLink>(resolve(root, "studies", studySpaceId, "curriculum-links"));
export const saveStudyTask = (root: string, value: StudyTask) => saveJson(taskPath(root, value.studySpaceId, value.id), value);
export const loadStudyTask = (root: string, studySpaceId: string, taskId: string) => loadJson<StudyTask>(taskPath(root, studySpaceId, taskId));
export const listStudyTasks = (root: string, studySpaceId: string) => listJson<StudyTask>(resolve(root, "studies", studySpaceId, "tasks"));
export const saveTaskSubmissionUnlocked = (root: string, value: StudyTaskSubmission) => saveJson(submissionPath(root, value.studySpaceId, value.taskId, value.userId), value);
export const saveTaskSubmission = (root: string, value: StudyTaskSubmission) => withDurableStudySubmissionLock(root, value.studySpaceId, value.taskId, value.userId, () => saveTaskSubmissionUnlocked(root, value), { waitForMs: 2_000 });
export const loadTaskSubmissionUnlocked = (root: string, studySpaceId: string, taskId: string, userId: string) => loadJson<StudyTaskSubmission>(submissionPath(root, studySpaceId, taskId, userId));
export const loadTaskSubmission = (root: string, studySpaceId: string, taskId: string, userId: string) => withDurableStudySubmissionLock(root, studySpaceId, taskId, userId, () => loadTaskSubmissionUnlocked(root, studySpaceId, taskId, userId), { waitForMs: 2_000 });
