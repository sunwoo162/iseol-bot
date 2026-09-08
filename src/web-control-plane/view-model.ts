import { loadEvaluationReport } from "../evaluation/report-store.js";
import { evaluationDirectory, listEvaluationJsonFiles } from "../evaluation/store-utils.js";
import { loadHarnessRun } from "../harness/run-store.js";
import { listIdeaLabCampaigns } from "../idea-lab/campaign-store.js";
import { listPrototypeProductions } from "../idea-lab/production-store.js";
import { loadProjectHistory } from "../project-model/history-store.js";
import { listPrototypeCandidates } from "../project-model/prototype-store.js";
import { loadProjectWorkspace } from "../project-model/workspace-store.js";
import type {
  EvaluationView,
  IdeaLabView,
  ProjectWorkspaceView,
  WebEvaluationReportSummary,
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
const EVALUATION_SECRET_ASSIGNMENT = /\b(token|cookie|secret|password)\s*[:=]\s*[^\s,;]+/gi;
const EVALUATION_BEARER_SECRET = /\bBearer\s+[^\s,;]+/gi;

function safeEvaluationText(value: string, maxLength = 240): string {
  return value
    .replace(EVALUATION_BEARER_SECRET, "Bearer [REDACTED]")
    .replace(EVALUATION_SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[REDACTED]`)
    .slice(0, maxLength);
}

function toEvaluationSummary(
  report: NonNullable<Awaited<ReturnType<typeof loadEvaluationReport>>>,
): WebEvaluationReportSummary {
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  for (const scenario of report.scenarios) {
    if (scenario.status === "passed") passed += 1;
    else if (scenario.status === "blocked-external") blocked += 1;
    else failed += 1;
  }
  return {
    evaluationId: report.evaluationId,
    suiteId: report.suiteId,
    status: report.status,
    completedAt: report.completedAt,
    counts: { passed, failed, blocked },
    duplicateSideEffectCount: report.metrics.duplicateSideEffectCount,
    unexpectedMutationCount: report.metrics.unexpectedMutationCount,
    recoveryLatencyMs: report.metrics.recoveryLatencyMs,
    failedInvariantIds: report.invariants
      .filter((item) => item.status === "failed")
      .map((item) => item.id)
      .slice(0, 20),
    failedScenarios: report.scenarios
      .filter((item) => item.status !== "passed" && item.status !== "blocked-external")
      .slice(0, 25)
      .map((item) => ({
        scenarioId: item.scenarioId,
        evaluationId: item.evaluationId,
        seed: item.seed,
        status: item.status,
      })),
    liveBlockers: report.liveBlockers.slice(0, 10).map((item) => safeEvaluationText(item)),
  };
}
export async function buildEvaluationView(root: string): Promise<EvaluationView> {
  const reports = [];
  for (const name of await listEvaluationJsonFiles(evaluationDirectory(root, "reports"))) {
    const report = await loadEvaluationReport(root, name.slice(0, -5));
    if (report) reports.push(report);
  }
  reports.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.evaluationId.localeCompare(b.evaluationId));
  const latestQuick = reports.filter((item) => item.suiteId === "quick-evaluation").at(-1) ?? null;
  const latestSoak = reports.filter((item) => item.suiteId === "soak-evaluation").at(-1) ?? null;
  return {
    quick: latestQuick ? toEvaluationSummary(latestQuick) : null,
    soak: latestSoak ? toEvaluationSummary(latestSoak) : null,
  };
}
