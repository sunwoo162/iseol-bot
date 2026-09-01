import type { StoredProject } from "../projects.js";

export type ProjectHealthState =
  | "connected"
  | "needs_setup"
  | "needs_admin"
  | "checking"
  | "repair";

export type ProjectHealth = {
  github: ProjectHealthState;
  review: ProjectHealthState;
  calendar: ProjectHealthState;
  scrum: ProjectHealthState;
  notion: ProjectHealthState;
  figma: ProjectHealthState;
};

const stateCopy: Record<ProjectHealthState, string> = {
  connected: "✅ 연결됨",
  needs_setup: "⚠️ 설정 필요",
  needs_admin: "⚠️ 관리자 설정 필요",
  checking: "⏳ 확인 중",
  repair: "❌ 복구 필요",
};

export function storedProjectHealth(project: StoredProject): ProjectHealth {
  return {
    github: project.frontendHookId !== undefined && project.backendHookId !== undefined
      ? "connected"
      : "repair",
    review: "checking",
    calendar: project.calendarId ? "connected" : "needs_setup",
    scrum: project.scrumChannelId && project.scrumPanelMessageId ? "connected" : "repair",
    notion: project.notionUrl ? "connected" : "needs_setup",
    figma: project.figmaUrl ? "connected" : "needs_setup",
  };
}

export function projectHealthLines(health: ProjectHealth): string[] {
  return [
    `🐙 GitHub · ${stateCopy[health.github]}`,
    `🔍 Code Review · ${stateCopy[health.review]}`,
    `📅 Google Calendar · ${stateCopy[health.calendar]}`,
    `📋 Scrum · ${stateCopy[health.scrum]}`,
    `📄 Notion · ${stateCopy[health.notion]}`,
    `🎨 Figma · ${stateCopy[health.figma]}`,
  ];
}

export function projectHealthIssues(health: ProjectHealth): string[] {
  const issues: string[] = [];
  if (health.github === "repair") issues.push("🐙 GitHub 연동 복구가 필요합니다.");
  if (health.github === "needs_admin") issues.push("🐙 GitHub 관리자 설정이 필요합니다.");
  if (health.review === "repair") issues.push("🔍 Code Review 복구가 필요합니다.");
  if (health.review === "needs_admin") issues.push("🔍 Code Review 관리자 설정이 필요합니다.");
  if (health.calendar === "needs_setup") issues.push("📅 Google Calendar 설정이 필요합니다.");
  if (health.calendar === "repair") issues.push("📅 Google Calendar 복구가 필요합니다.");
  if (health.scrum === "repair") issues.push("📋 Scrum 자동 복구가 필요합니다.");
  if (health.notion === "needs_setup") issues.push("📄 Notion 링크 설정이 필요합니다.");
  if (health.figma === "needs_setup") issues.push("🎨 Figma 링크 설정이 필요합니다.");
  return issues;
}
