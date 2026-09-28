import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { assertIdentityId } from "../identity/contracts.js";
import { renameWithTransientRetry } from "../desktop-agent/atomic-file.js";
import type { CodeAnalysisResult, CodingAttempt, CodingExercise, GoalInterpretation, LearningAnswerReceipt, LearningContentRequest, LearningFeedback, LearningFeedbackDispute, LearningGoal, LearningLink, LearningPlan, LearningPlanAdjustment, LearningPlanVersion, LearningProjectApplication, LearningReport, LearningSession, LearningSessionAction, ReviewItem, StudyAttempt } from "./contracts.js";

type LearningKind = "goals" | "plans" | "plan-versions" | "interpretations" | "sessions" | "attempts" | "reviews" | "analyses" | "coding-exercises" | "coding-attempts" | "content-requests" | "actions" | "answers" | "feedback" | "disputes" | "adjustments" | "project-proposals" | "links" | "reports";
function directory(root: string, userId: string, kind: LearningKind): string { assertIdentityId(userId); return resolve(root, "users", userId, "learning", kind); }
function pathFor(root: string, userId: string, kind: LearningKind, id: string): string { assertIdentityId(id); return resolve(directory(root, userId, kind), id + ".json"); }
async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + process.pid + "." + randomBytes(4).toString("hex") + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await renameWithTransientRetry(temporary, path);
}
async function loadJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function listJson<T>(root: string, userId: string, kind: LearningKind): Promise<T[]> {
  let names: string[];
  try { names = await readdir(directory(root, userId, kind)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const values: T[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    try { values.push(JSON.parse(await readFile(resolve(directory(root, userId, kind), name), "utf8")) as T); } catch { /* malformed private rows stay hidden */ }
  }
  return values;
}

export const savePlan = (root: string, value: LearningPlan) => saveJson(pathFor(root, value.userId, "plans", value.id), value);
export const loadPlan = (root: string, userId: string, id: string) => loadJson<LearningPlan>(pathFor(root, userId, "plans", id));
export const listPlans = (root: string, userId: string) => listJson<LearningPlan>(root, userId, "plans");
export const saveLearningGoal = (root: string, value: LearningGoal) => saveJson(pathFor(root, value.userId, "goals", value.id), value);
export const loadLearningGoal = (root: string, userId: string, id: string) => loadJson<LearningGoal>(pathFor(root, userId, "goals", id));
export const listLearningGoals = (root: string, userId: string) => listJson<LearningGoal>(root, userId, "goals");
export const saveGoalInterpretation = (root: string, value: GoalInterpretation) => saveJson(pathFor(root, value.userId, "interpretations", value.id), value);
export const loadGoalInterpretation = (root: string, userId: string, id: string) => loadJson<GoalInterpretation>(pathFor(root, userId, "interpretations", id));
export const listGoalInterpretations = (root: string, userId: string) => listJson<GoalInterpretation>(root, userId, "interpretations");
export const saveLearningPlanVersion = (root: string, value: LearningPlanVersion) => saveJson(pathFor(root, value.userId, "plan-versions", value.id), value);
export const loadLearningPlanVersion = (root: string, userId: string, id: string) => loadJson<LearningPlanVersion>(pathFor(root, userId, "plan-versions", id));
export const listLearningPlanVersions = (root: string, userId: string) => listJson<LearningPlanVersion>(root, userId, "plan-versions");
export const saveLearningPlanAdjustment = (root: string, value: LearningPlanAdjustment) => saveJson(pathFor(root, value.userId, "adjustments", value.id), value);
export const loadLearningPlanAdjustment = (root: string, userId: string, id: string) => loadJson<LearningPlanAdjustment>(pathFor(root, userId, "adjustments", id));
export const listLearningPlanAdjustments = (root: string, userId: string) => listJson<LearningPlanAdjustment>(root, userId, "adjustments");
export const saveSession = (root: string, value: LearningSession) => saveJson(pathFor(root, value.userId, "sessions", value.id), value);
function normalizeSession(value: LearningSession): LearningSession {
  const revision = Number.isInteger(value.revision) && value.revision >= 1 ? value.revision : 1;
  return { ...value, revision };
}
export async function loadSession(root: string, userId: string, id: string): Promise<LearningSession | null> {
  const value = await loadJson<LearningSession>(pathFor(root, userId, "sessions", id));
  return value ? normalizeSession(value) : null;
}
export async function listSessions(root: string, userId: string): Promise<LearningSession[]> {
  return (await listJson<LearningSession>(root, userId, "sessions")).map(normalizeSession);
}
export const saveLearningContentRequest = (root: string, value: LearningContentRequest) => saveJson(pathFor(root, value.userId, "content-requests", value.id), value);
export const loadLearningContentRequest = (root: string, userId: string, id: string) => loadJson<LearningContentRequest>(pathFor(root, userId, "content-requests", id));
export const listLearningContentRequests = (root: string, userId: string) => listJson<LearningContentRequest>(root, userId, "content-requests");
export const saveLearningSessionAction = (root: string, value: LearningSessionAction) => saveJson(pathFor(root, value.userId, "actions", value.id), value);
export const listLearningSessionActions = (root: string, userId: string) => listJson<LearningSessionAction>(root, userId, "actions");
export const saveLearningAnswerReceipt = (root: string, value: LearningAnswerReceipt) => saveJson(pathFor(root, value.userId, "answers", value.id), value);
export const loadLearningAnswerReceipt = (root: string, userId: string, id: string) => loadJson<LearningAnswerReceipt>(pathFor(root, userId, "answers", id));
export const listLearningAnswerReceipts = (root: string, userId: string) => listJson<LearningAnswerReceipt>(root, userId, "answers");
export const saveLearningFeedback = (root: string, value: LearningFeedback) => saveJson(pathFor(root, value.userId, "feedback", value.id), value);
export const loadLearningFeedback = (root: string, userId: string, id: string) => loadJson<LearningFeedback>(pathFor(root, userId, "feedback", id));
export const listLearningFeedback = (root: string, userId: string) => listJson<LearningFeedback>(root, userId, "feedback");
export const saveLearningFeedbackDispute = (root: string, value: LearningFeedbackDispute) => saveJson(pathFor(root, value.userId, "disputes", value.id), value);
export const listLearningFeedbackDisputes = (root: string, userId: string) => listJson<LearningFeedbackDispute>(root, userId, "disputes");
export const saveAttempt = (root: string, value: StudyAttempt) => saveJson(pathFor(root, value.userId, "attempts", value.id), value);
export const listAttempts = (root: string, userId: string) => listJson<StudyAttempt>(root, userId, "attempts");
export const saveReview = (root: string, value: ReviewItem) => saveJson(pathFor(root, value.userId, "reviews", value.id), value);
export const loadReview = (root: string, userId: string, id: string) => loadJson<ReviewItem>(pathFor(root, userId, "reviews", id));
export const listReviews = (root: string, userId: string) => listJson<ReviewItem>(root, userId, "reviews");
export const saveAnalysis = (root: string, value: CodeAnalysisResult) => saveJson(pathFor(root, value.userId, "analyses", value.id), value);
export const loadAnalysis = (root: string, userId: string, id: string) => loadJson<CodeAnalysisResult>(pathFor(root, userId, "analyses", id));
export const saveCodingExercise = (root: string, value: CodingExercise) => saveJson(pathFor(root, value.userId, "coding-exercises", value.id), value);
export const loadCodingExercise = (root: string, userId: string, id: string) => loadJson<CodingExercise>(pathFor(root, userId, "coding-exercises", id));
export const listCodingExercises = (root: string, userId: string) => listJson<CodingExercise>(root, userId, "coding-exercises");
export const saveCodingAttempt = (root: string, value: CodingAttempt) => saveJson(pathFor(root, value.userId, "coding-attempts", value.id), value);
export const listCodingAttempts = (root: string, userId: string) => listJson<CodingAttempt>(root, userId, "coding-attempts");
export const saveLearningProjectApplication = (root: string, value: LearningProjectApplication) => saveJson(pathFor(root, value.userId, "project-proposals", value.id), value);
export const loadLearningProjectApplication = (root: string, userId: string, id: string) => loadJson<LearningProjectApplication>(pathFor(root, userId, "project-proposals", id));
export const listLearningProjectApplications = (root: string, userId: string) => listJson<LearningProjectApplication>(root, userId, "project-proposals");
export const saveLearningLink = (root: string, value: LearningLink) => saveJson(pathFor(root, value.userId, "links", value.id), value);
export const loadLearningLink = (root: string, userId: string, id: string) => loadJson<LearningLink>(pathFor(root, userId, "links", id));
export const listLearningLinks = (root: string, userId: string) => listJson<LearningLink>(root, userId, "links");
export const saveLearningReport = (root: string, value: LearningReport) => saveJson(pathFor(root, value.userId, "reports", value.id), value);
export const listLearningReports = (root: string, userId: string) => listJson<LearningReport>(root, userId, "reports");
