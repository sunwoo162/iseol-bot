export type ProjectHubAction =
  | "calendar"
  | "scrum"
  | "github"
  | "review"
  | "refresh"
  | "admin";

export function buildProjectHubId(action: ProjectHubAction, projectId: string): string {
  return `project_hub:${action}:${projectId}`;
}

export function parseProjectHubId(
  customId: string,
): { action: ProjectHubAction; projectId: string } | null {
  const match = /^project_hub:(calendar|scrum|github|review|refresh|admin):([A-Za-z0-9_-]+)$/.exec(customId);
  return match
    ? { action: match[1] as ProjectHubAction, projectId: match[2]! }
    : null;
}
