import type { StoredProject } from "../projects.js";
import type { ReviewWorkflowInstallResult } from "../review/review-workflow-install.js";

export type ProjectExperienceEnsureResult = {
  hubPanelMessageId?: string;
  scrumChannelId?: string;
  scrumPanelMessageId?: string;
};

export type ProjectRepairDependencies = {
  ensureExperience(project: StoredProject): Promise<ProjectExperienceEnsureResult>;
  ensureReviewWorkflows(project: StoredProject): Promise<ReviewWorkflowInstallResult[]>;
};

export type ProjectRepairResult = {
  repaired: string[];
  unchanged: string[];
  needsAdmin: string[];
  failed: string[];
};

function experienceChanged(project: StoredProject, ensured: ProjectExperienceEnsureResult): boolean {
  return (
    (!!ensured.hubPanelMessageId && ensured.hubPanelMessageId !== project.hubPanelMessageId)
    || (!!ensured.scrumChannelId && ensured.scrumChannelId !== project.scrumChannelId)
    || (!!ensured.scrumPanelMessageId && ensured.scrumPanelMessageId !== project.scrumPanelMessageId)
  );
}

function looksLikeAdminPermissionError(error: string): boolean {
  const normalized = error.toLowerCase();
  return [
    "403",
    "forbidden",
    "permission",
    "resource not accessible",
    "workflow",
  ].some((keyword) => normalized.includes(keyword));
}

export async function repairProject(
  project: StoredProject,
  dependencies: ProjectRepairDependencies,
): Promise<ProjectRepairResult> {
  const result: ProjectRepairResult = {
    repaired: [],
    unchanged: [],
    needsAdmin: [],
    failed: [],
  };

  try {
    const ensured = await dependencies.ensureExperience(project);
    if (experienceChanged(project, ensured)) result.repaired.push("Discord 프로젝트 패널");
    else result.unchanged.push("Discord 프로젝트 패널");
  } catch {
    result.failed.push("Discord 프로젝트 패널");
  }

  let reviewResults: ReviewWorkflowInstallResult[];
  try {
    reviewResults = await dependencies.ensureReviewWorkflows(project);
  } catch {
    result.failed.push("Code Review 워크플로우");
    return result;
  }

  for (const review of reviewResults) {
    const label = `Code Review · ${review.repository}`;
    if (!review.error) {
      if (review.created) result.repaired.push(label);
      else result.unchanged.push(label);
      continue;
    }

    if (looksLikeAdminPermissionError(review.error)) result.needsAdmin.push(label);
    else result.failed.push(label);
  }

  return result;
}
