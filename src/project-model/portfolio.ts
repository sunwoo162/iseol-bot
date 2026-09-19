import { loadHarnessRun } from "../harness/run-store.js";
import type { HarnessEvidenceRecord, HarnessRuntimeRunEnvelope } from "../harness/contracts.js";
import { loadProjectHistory } from "./history-store.js";
import { loadProjectWorkspace } from "./workspace-store.js";
import type { ProjectWorkspace } from "./contracts.js";

export type ProjectEvidence = {
  id: string;
  kind: string;
  summary: string;
  reference?: string;
  source: "project" | "run" | "history";
  runId?: string;
};

export type ProjectEvidenceBundle = {
  projectId: string;
  projectName: string;
  objective: string;
  repository: { url: string; branch: string; commitSha: string };
  deployment: { url: string; provider?: string };
  features: Array<{ id: string; title: string; status: string; runIds: string[] }>;
  runs: Array<{ runId: string; stage: string; status: string; objective: string }>;
  evidence: ProjectEvidence[];
};

export type PortfolioClaim = {
  id: string;
  text: string;
  evidenceIds: string[];
};

export type PortfolioDraft = {
  version: 1;
  projectId: string;
  generatedAt: string;
  overview: string;
  features: string[];
  technology: string[];
  troubleshooting: string[];
  claims: PortfolioClaim[];
  readme: string;
};

function safeText(value: string, max = 500): string {
  return value
    .replace(/https?:\/\/[^/\s:@]+:[^@\s]+@/gi, "https://[redacted]@")
    .replace(/\b(token|cookie|secret|password|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, max);
}

function evidenceFromRun(run: HarnessRuntimeRunEnvelope): ProjectEvidence[] {
  return run.evidence.slice(0, 200).map((record: HarnessEvidenceRecord) => ({
    id: record.id,
    kind: record.kind,
    summary: safeText(record.summary),
    ...(record.reference ? { reference: safeText(record.reference, 240) } : {}),
    source: "run",
    runId: run.request.runId,
  }));
}

export async function collectProjectEvidence(
  modelRoot: string,
  runRoot: string,
  projectId: string,
): Promise<ProjectEvidenceBundle> {
  const workspace = await loadProjectWorkspace(modelRoot, projectId);
  if (!workspace) throw new Error(`Project workspace not found: ${projectId}`);
  const runIds = [...new Set(workspace.tree.flatMap((node) => node.runIds))];
  const runs: HarnessRuntimeRunEnvelope[] = [];
  for (const runId of runIds) {
    const run = await loadHarnessRun(runRoot, runId);
    if (run) runs.push(run);
  }
  const evidence: ProjectEvidence[] = [
    { id: `project:${workspace.id}:repository`, kind: "repository", summary: `저장소 ${safeText(workspace.genesis.repository.url, 240)} (${safeText(workspace.genesis.repository.branch, 120)})`, reference: safeText(workspace.genesis.repository.commitSha, 120), source: "project" },
    { id: `project:${workspace.id}:deployment`, kind: "deployment", summary: `배포 주소 ${safeText(workspace.genesis.deployment.url, 240)}`, source: "project" },
    ...runs.flatMap(evidenceFromRun),
  ];
  const history = await loadProjectHistory(modelRoot, projectId);
  evidence.push(...history.slice(0, 200).map((event) => ({
    id: event.id, kind: event.type, summary: safeText(event.summary), ...(event.reference ? { reference: safeText(event.reference, 240) } : {}), source: "history" as const, ...(event.runId ? { runId: event.runId } : {}),
  })));
  return {
    projectId: workspace.id,
    projectName: safeText(workspace.name, 160),
    objective: safeText(runs[0]?.request.objective ?? workspace.name),
    repository: { url: safeText(workspace.genesis.repository.url, 240), branch: safeText(workspace.genesis.repository.branch, 120), commitSha: safeText(workspace.genesis.repository.commitSha, 120) },
    deployment: { url: workspace.genesis.deployment.url, ...(workspace.genesis.deployment.provider ? { provider: workspace.genesis.deployment.provider } : {}) },
    features: workspace.tree.filter((node) => node.kind === "feature" || node.kind === "task").map((node) => ({ id: node.id, title: safeText(node.title, 160), status: node.status, runIds: [...node.runIds] })),
    runs: runs.map((run) => ({ runId: run.request.runId, stage: run.state.stage, status: run.state.status, objective: safeText(run.request.objective) })),
    evidence,
  };
}

function humanize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function buildPortfolioDraft(bundle: ProjectEvidenceBundle, generatedAt = new Date().toISOString()): PortfolioDraft {
  const repositoryEvidence = bundle.evidence.find((item) => item.kind === "repository");
  const featureClaims = bundle.features.map((feature) => {
    const evidenceIds = feature.runIds.flatMap((runId) => bundle.evidence.filter((item) => item.runId === runId).map((item) => item.id));
    return { id: `feature:${feature.id}`, text: `${feature.title} 기능은 기록된 작업 트리에 포함되어 있습니다.`, evidenceIds: [...new Set(evidenceIds)] };
  }).filter((claim) => claim.evidenceIds.length > 0);
  const testEvidence = bundle.evidence.filter((item) => item.kind === "test" || item.kind === "build");
  const claims: PortfolioClaim[] = [
    { id: "project-overview", text: `${bundle.projectName}은(는) ${bundle.objective}를 목표로 합니다.`, evidenceIds: repositoryEvidence ? [repositoryEvidence.id] : [] },
    ...featureClaims,
    ...(testEvidence.length > 0 ? [{ id: "verification", text: "테스트 또는 빌드 결과가 개발 기록에 남아 있습니다.", evidenceIds: testEvidence.map((item) => item.id) }] : []),
  ].filter((claim) => claim.evidenceIds.length > 0).map((claim) => ({ ...claim, text: humanize(claim.text) }));
  const features = bundle.features.map((feature) => `${feature.title} (${feature.status})`);
  const technology = [`저장소: ${bundle.repository.url}`, `브랜치: ${bundle.repository.branch}`, `기준 커밋: ${bundle.repository.commitSha}`];
  const troubleshooting = bundle.evidence.filter((item) => /fail|error|recover|reject|실패|복구/i.test(item.summary)).map((item) => `${item.summary} [근거: ${item.id}]`);
  const readme = [`# ${bundle.projectName}`, "", bundle.objective, "", "## 주요 기능", ...(features.length ? features.map((item) => `- ${item}`) : ["- 기록된 기능이 없습니다."]), "", "## 검증", ...(testEvidence.length ? testEvidence.map((item) => `- ${item.summary}`) : ["- 기록된 테스트 또는 빌드 근거가 없습니다."])].join("\n");
  return { version: 1, projectId: bundle.projectId, generatedAt, overview: humanize(`${bundle.projectName}: ${bundle.objective}`), features, technology, troubleshooting, claims, readme };
}

export function verifyPortfolioGrounding(draft: PortfolioDraft, bundle: ProjectEvidenceBundle): { grounded: boolean; ungroundedClaimIds: string[] } {
  const ids = new Set(bundle.evidence.map((item) => item.id));
  const ungroundedClaimIds = draft.claims.filter((claim) => claim.evidenceIds.length === 0 || claim.evidenceIds.some((id) => !ids.has(id))).map((claim) => claim.id);
  return { grounded: ungroundedClaimIds.length === 0, ungroundedClaimIds };
}
