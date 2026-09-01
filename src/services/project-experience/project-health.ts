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
