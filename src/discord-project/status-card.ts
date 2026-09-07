import type { HarnessRuntimeRunEnvelope } from "../harness/contracts.js";
import type { ProjectWorkspace } from "../project-model/contracts.js";
import type { DiscordProjectContext } from "./contracts.js";

export type DiscordProjectStatusView = {
  legacy: { projectId: string; name: string; frontend: string; backend: string };
  integrations: { calendar: boolean; figma: boolean; notion: boolean };
  workspace: {
    state: "unbound" | "bound" | "stale";
    reason?: string;
    projectName?: string;
    projectStatus?: ProjectWorkspace["status"];
    deploymentUrl?: string;
    node?: ProjectWorkspace["tree"][number];
    runs: Array<{ runId: string; stage: string; status: string; updatedAt: string }>;
  };
};

export type DiscordProjectStatusDependencies = {
  loadWorkspace(projectId: string): Promise<ProjectWorkspace | null>;
  loadRun(runId: string): Promise<HarnessRuntimeRunEnvelope | null>;
};

function legacyView(context: DiscordProjectContext): Omit<DiscordProjectStatusView, "workspace"> {
  return {
    legacy: {
      projectId: context.legacy.projectId,
      name: context.legacy.name,
      frontend: context.legacy.repositories.frontend.url,
      backend: context.legacy.repositories.backend.url,
    },
    integrations: {
      calendar: Boolean(context.legacy.integrations.calendar.id || context.legacy.integrations.calendar.url),
      figma: Boolean(context.legacy.integrations.figma.url || context.legacy.integrations.figma.fileKey),
      notion: Boolean(context.legacy.integrations.notion.url || context.legacy.integrations.notion.pageId),
    },
  };
}

export async function buildDiscordProjectStatus(
  context: DiscordProjectContext,
  deps: DiscordProjectStatusDependencies,
): Promise<DiscordProjectStatusView> {
  const base = legacyView(context);
  if (context.state === "legacy-only") {
    return { ...base, workspace: { state: "unbound", runs: [] } };
  }
  if (context.state === "stale-binding" || !context.binding || !context.work?.nodeId) {
    return {
      ...base,
      workspace: { state: "stale", runs: [], ...(context.staleReason ? { reason: context.staleReason } : {}) },
    };
  }
  const workspace = await deps.loadWorkspace(context.binding.projectId);
  if (!workspace) {
    return { ...base, workspace: { state: "stale", reason: "Project Workspace is missing", runs: [] } };
  }
  const node = workspace.tree.find((item) => item.id === context.work!.nodeId);
  if (!node) {
    return { ...base, workspace: { state: "stale", reason: "Project tree node is missing", runs: [] } };
  }
  const runs: DiscordProjectStatusView["workspace"]["runs"] = [];
  for (const runId of node.runIds) {
    const run = await deps.loadRun(runId);
    if (!run) continue;
    runs.push({ runId, stage: run.state.stage, status: run.state.status, updatedAt: run.updatedAt });
  }
  return {
    ...base,
    workspace: {
      state: "bound",
      projectName: workspace.name,
      projectStatus: workspace.status,
      deploymentUrl: workspace.genesis.deployment.url,
      node: { ...node, runIds: [...node.runIds] },
      runs,
    },
  };
}
