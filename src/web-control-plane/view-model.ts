import { loadHarnessRun } from "../harness/run-store.js";
import { listIdeaLabCampaigns } from "../idea-lab/campaign-store.js";
import { listPrototypeProductions } from "../idea-lab/production-store.js";
import { loadProjectHistory } from "../project-model/history-store.js";
import { listPrototypeCandidates } from "../project-model/prototype-store.js";
import { loadProjectWorkspace } from "../project-model/workspace-store.js";
import type {
  IdeaLabView,
  ProjectWorkspaceView,
  WebIdeaLabCampaignSummary,
  WebIdeaLabProductionSummary,
  WebPrototypeCard,
  WebRunSummary,
} from "./contracts.js";

function toPrototypeCard(
  candidate: Awaited<ReturnType<typeof listPrototypeCandidates>>[number],
): WebPrototypeCard {
  return {
    id: candidate.id,
    title: candidate.title,
    concept: candidate.concept,
    status: candidate.status,
    repository: { ...candidate.repository },
    deployment: {
      url: candidate.deployment.url,
      ...(candidate.deployment.provider === undefined
        ? {}
        : { provider: candidate.deployment.provider }),
    },
    ...(candidate.promotedProjectId === undefined
      ? {}
      : { promotedProjectId: candidate.promotedProjectId }),
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

function safeIdeaLabSummary(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/\b(token|cookie|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240);
}

export async function buildIdeaLabView(
  modelRoot: string,
  harnessRoot = modelRoot,
): Promise<IdeaLabView> {
  const prototypes = await listPrototypeCandidates(modelRoot);
  const campaigns = await listIdeaLabCampaigns(modelRoot);
  const productions = await listPrototypeProductions(modelRoot);
  const campaignViews: WebIdeaLabCampaignSummary[] = campaigns.map((campaign) => ({
    id: campaign.id,
    seed: campaign.seed,
    status: campaign.status,
    targetReadyCount: campaign.targetReadyCount,
    readyCount: productions.filter((item) => item.campaignId === campaign.id && item.status === "ready").length,
    productionCount: productions.filter((item) => item.campaignId === campaign.id).length,
    productionConcurrency: campaign.productionConcurrency,
    ...(safeIdeaLabSummary(campaign.blockerSummary) ? { blockerSummary: safeIdeaLabSummary(campaign.blockerSummary) } : {}),
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
  }));
  const productionViews: WebIdeaLabProductionSummary[] = [];
  for (const production of productions) {
    const run = await buildRunSummary(harnessRoot, production.runId);
    productionViews.push({
      id: production.id,
      campaignId: production.campaignId,
      proposalId: production.proposalId,
      runId: production.runId,
      status: production.status,
      branch: production.branch,
      ...(production.commitSha ? { commitSha: production.commitSha } : {}),
      ...(production.deployment?.url ? { deploymentUrl: production.deployment.url } : {}),
      ...(safeIdeaLabSummary(production.blockerSummary) ? { blockerSummary: safeIdeaLabSummary(production.blockerSummary) } : {}),
      updatedAt: production.updatedAt,
      ...(run ? { run } : {}),
    });
  }
  return { prototypes: prototypes.map(toPrototypeCard), campaigns: campaignViews, productions: productionViews };
}

function collectAttachedRunIds(
  tree: ProjectWorkspaceView["tree"],
): string[] {
  const ids = new Set<string>();
  for (const node of tree) {
    for (const runId of node.runIds) ids.add(runId);
  }
  return [...ids];
}

async function buildRunSummary(
  harnessRoot: string,
  runId: string,
): Promise<WebRunSummary | null> {
  const run = await loadHarnessRun(harnessRoot, runId);
  if (!run) return null;
  return {
    runId,
    objective: run.request.objective,
    stage: run.state.stage,
    status: run.state.status,
    updatedAt: run.updatedAt,
    ...(run.preflight.policy?.effectiveSha256 === undefined
      ? {}
      : { policySha256: run.preflight.policy.effectiveSha256 }),
    evidenceCount: run.evidence.length,
  };
}

export async function buildProjectWorkspaceView(
  modelRoot: string,
  harnessRoot: string,
  projectId: string,
): Promise<ProjectWorkspaceView | null> {
  const workspace = await loadProjectWorkspace(modelRoot, projectId);
  if (!workspace) return null;

  const history = await loadProjectHistory(modelRoot, workspace.id);
  const runs: WebRunSummary[] = [];
  for (const runId of collectAttachedRunIds(workspace.tree)) {
    const summary = await buildRunSummary(harnessRoot, runId);
    if (summary) runs.push(summary);
  }

  return {
    project: {
      id: workspace.id,
      name: workspace.name,
      status: workspace.status,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    },
    genesis: structuredClone(workspace.genesis),
    tree: workspace.tree.map((node) => ({ ...node, runIds: [...node.runIds] })),
    history: history.map((event) => ({ ...event })),
    runs,
  };
}
