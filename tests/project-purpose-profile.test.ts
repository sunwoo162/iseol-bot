import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveExecutionProfile,
  type AgentRoleRegistration,
} from "../src/project-model/execution-profile.js";
import {
  buildPortfolioDraft,
  collectProjectEvidence,
  verifyPortfolioGrounding,
} from "../src/project-model/portfolio.js";
import type { ProjectWorkspace } from "../src/project-model/contracts.js";
import { saveProjectWorkspace } from "../src/project-model/workspace-store.js";
import { loadProjectHistory } from "../src/project-model/history-store.js";
import { saveHarnessRun } from "../src/harness/run-store.js";
import type { HarnessRuntimeRunEnvelope } from "../src/harness/contracts.js";
import { loadHarnessRun } from "../src/harness/run-store.js";
import { routeWebControlPlaneRequest } from "../src/web-control-plane/router.js";

test("purpose profile selects executable stage adapters and labels unsupported specialists as planned", () => {
  const roles: AgentRoleRegistration[] = [
    { id: "orchestrator", kind: "stage-adapter", status: "registered" },
    { id: "planning", kind: "stage-adapter", status: "registered" },
    { id: "frontend", kind: "stage-adapter", status: "registered" },
    { id: "qa", kind: "stage-adapter", status: "registered" },
    { id: "documentation", kind: "specialist", status: "planned" },
  ];
  const result = resolveExecutionProfile({
    purpose: "portfolio",
    objective: "학생용 공부 기록 웹 서비스",
    roles,
  });
  assert.deepEqual(result.executableRoles, ["orchestrator", "planning", "frontend", "qa"]);
  assert.deepEqual(result.plannedRoles, ["review", "design-system", "documentation", "user"]);
  assert.match(result.koreanSummary, /포트폴리오/);
});

test("purpose profile fails closed for empty requirements and unsupported purpose", () => {
  assert.throws(() => resolveExecutionProfile({ purpose: "portfolio", objective: "", roles: [] }), /objective/i);
  assert.throws(() => resolveExecutionProfile({ purpose: "unknown" as never, objective: "x", roles: [] }), /purpose/i);
});

test("control plane exposes purpose selection without exposing internal registries", async () => {
  const profile = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/execution-profile", headers: {},
    body: { purpose: "rapid-prototype", objective: "학생용 공부 기록 서비스" },
  }, { modelRoot: "unused", harnessRoot: "unused" });
  assert.equal(profile.status, 200);
  assert.deepEqual((profile.body as { executableRoles: string[] }).executableRoles, ["orchestrator", "planning", "frontend", "qa"]);
  assert.equal("roles" in (profile.body as Record<string, unknown>), false);
});

test("portfolio draft is grounded in durable workspace and run evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-portfolio-"));
  const at = "2026-09-19T00:00:00.000Z";
  const run: HarnessRuntimeRunEnvelope = {
    version: 1,
    request: { version: 1, runId: "run-portfolio", mode: "project-workspace", objective: "공부 기록 서비스", targetRoot: root },
    preflight: { version: 1, runId: "run-portfolio", status: "ready", policy: { version: 1, loadedAt: at, sources: [], effectiveSha256: "a".repeat(64) } },
    state: { version: 1, stage: "TEST", status: "DONE", completedStages: ["PREFLIGHT", "TEST"], skippedStages: [], updatedAt: at },
    evidence: [{ version: 1, id: "ev-test", kind: "test", stage: "TEST", recordedAt: at, summary: "npm test passed", reference: "test-run" }],
    updatedAt: at,
  };
  await saveHarnessRun(join(root, "runs"), run);
  const workspace: ProjectWorkspace = {
    version: 1, id: "project-study", name: "Study Log", status: "active",
    genesis: { prototypeId: "prototype-study", repository: { url: "https://user:password@example.test/study?token=secret", branch: "main", commitSha: "abc" }, deployment: { url: "https://study.test" }, runs: [], promotedAt: at },
    tree: [
      { id: "root", kind: "root", title: "Study Log", status: "in-progress", runIds: ["run-portfolio"], createdAt: at, updatedAt: at },
      { id: "feature-timer", parentId: "root", kind: "feature", title: "공부 시간 기록", status: "done", runIds: ["run-portfolio"], createdAt: at, updatedAt: at },
    ], createdAt: at, updatedAt: at,
  };
  await saveProjectWorkspace(root, workspace);
  const purposeSaved = await routeWebControlPlaneRequest({
    method: "PUT", path: "/api/projects/project-study/purpose", headers: {},
    body: { purpose: "portfolio", objective: "학생용 공부 기록 웹 서비스" },
  }, { modelRoot: root, harnessRoot: join(root, "runs"), now: () => at });
  assert.equal(purposeSaved.status, 200);
  const savedView = purposeSaved.body as { purposeSelection?: { purpose: string; profile: { executableRoles: string[] } }; executionPlan?: { documentationRequired: boolean } };
  assert.equal(savedView.purposeSelection?.purpose, "portfolio");
  assert.equal(savedView.executionPlan?.documentationRequired, true);
  assert.deepEqual(savedView.purposeSelection?.profile.executableRoles, ["orchestrator", "planning", "frontend", "qa"]);
  const history = await loadProjectHistory(root, "project-study");
  assert.equal(history.at(-1)?.type, "purpose-selected");
  const reloadedView = await routeWebControlPlaneRequest({
    method: "GET", path: "/api/projects/project-study", headers: {},
  }, { modelRoot: root, harnessRoot: join(root, "runs") });
  assert.equal((reloadedView.body as typeof savedView).purposeSelection?.purpose, "portfolio");
  const evidence = await collectProjectEvidence(root, join(root, "runs"), "project-study");
  const draft = buildPortfolioDraft(evidence);
  assert.match(draft.overview, /Study Log/);
  assert.match(draft.readme, /공부 시간 기록/);
  assert.equal(draft.claims.every((claim) => claim.evidenceIds.length > 0), true);
  assert.deepEqual(verifyPortfolioGrounding(draft, evidence), { grounded: true, ungroundedClaimIds: [] });
  assert.equal(JSON.stringify(draft).includes("abc"), true);
  assert.equal(JSON.stringify(draft).includes("password"), false);
  assert.equal(JSON.stringify(draft).includes("secret"), false);

  const portfolio = await routeWebControlPlaneRequest({
    method: "GET", path: "/api/projects/project-study/portfolio", headers: {},
  }, { modelRoot: root, harnessRoot: join(root, "runs"), now: () => at });
  assert.equal(portfolio.status, 200);
  assert.equal((portfolio.body as { grounding: { grounded: boolean; documentGrounded: boolean } }).grounding.grounded, true);
  assert.equal((portfolio.body as { grounding: { documentGrounded: boolean } }).grounding.documentGrounded, true);
  assert.equal((portfolio.body as { evidence: Array<{ id: string }> }).evidence.some((item) => item.id === "ev-test"), true);
  const document = (portfolio.body as { document: { sections: Array<{ id: string; content: string; generatedContent: string; included: boolean }>; readme: string } }).document;
  const edited = await routeWebControlPlaneRequest({
    method: "PUT", path: "/api/projects/project-study/portfolio", headers: {},
    body: { sections: [{ id: "features", content: "사용자 편집 기능", included: true }, { id: "technology", content: "", included: false }], readme: "# Study Log\n\n사용자 편집 README" },
  }, { modelRoot: root, harnessRoot: join(root, "runs"), now: () => at });
  assert.equal(edited.status, 200);
  const saved = (edited.body as { document: typeof document }).document;
  assert.equal(saved.sections.find((section) => section.id === "features")?.content, "사용자 편집 기능");
  assert.equal(saved.sections.find((section) => section.id === "features")?.generatedContent, document.sections.find((section) => section.id === "features")?.generatedContent);
  assert.equal(saved.sections.find((section) => section.id === "technology")?.included, false);
  const reloaded = await routeWebControlPlaneRequest({
    method: "GET", path: "/api/projects/project-study/portfolio", headers: {},
  }, { modelRoot: root, harnessRoot: join(root, "runs"), now: () => at });
  assert.equal((reloaded.body as { document: typeof document }).document.readme, "# Study Log\n\n사용자 편집 README");
  assert.equal((reloaded.body as { grounding: { documentGrounded: boolean; needsReview: string[] } }).grounding.documentGrounded, false);
  assert.equal((reloaded.body as { grounding: { needsReview: string[] } }).grounding.needsReview.includes("features"), true);
});

test("purpose selection is included in a new project run preparation without creating a run", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-purpose-preparation-"));
  const at = "2026-09-19T00:00:00.000Z";
  await saveProjectWorkspace(root, {
    version: 1, id: "project-prep", name: "Prepared project", status: "active",
    genesis: { prototypeId: "prototype-prep", repository: { url: "https://example.test/repo", branch: "main" }, deployment: { url: "https://example.test" }, runs: [], promotedAt: at },
    tree: [], createdAt: at, updatedAt: at,
  });
  const saved = await routeWebControlPlaneRequest({
    method: "PUT", path: "/api/projects/project-prep/purpose", headers: {},
    body: { purpose: "portfolio", objective: "실제 프로젝트를 포트폴리오로 정리" },
  }, { modelRoot: root, harnessRoot: join(root, "runs"), now: () => at });
  assert.equal(saved.status, 200);
  const prepared = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-prep/execution-preparation", headers: {},
    body: { runId: "run-prep", objective: "실제 프로젝트를 포트폴리오로 정리", targetRoot: root },
  }, { modelRoot: root, harnessRoot: join(root, "runs"), now: () => at });
  assert.equal(prepared.status, 200);
  const body = prepared.body as { request: { runId: string; purposeProfile: { purpose: string; executableRoles: string[] } }; plan: { plannedRoles: string[] } };
  assert.equal(body.request.runId, "run-prep");
  assert.equal(body.request.purposeProfile.purpose, "portfolio");
  assert.deepEqual(body.request.purposeProfile.executableRoles, ["orchestrator", "planning", "frontend", "qa"]);
  assert.ok(body.plan.plannedRoles.includes("documentation"));
  assert.equal(await loadHarnessRun(join(root, "runs"), "run-prep"), null);
});

test("run preparation refuses legacy workspaces without an explicit purpose", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-purpose-legacy-"));
  const at = "2026-09-19T00:00:00.000Z";
  await saveProjectWorkspace(root, {
    version: 1, id: "legacy-project", name: "Legacy", status: "active",
    genesis: { prototypeId: "prototype-legacy", repository: { url: "https://example.test/repo", branch: "main" }, deployment: { url: "https://example.test" }, runs: [], promotedAt: at },
    tree: [], createdAt: at, updatedAt: at,
  });
  const prepared = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/legacy-project/execution-preparation", headers: {},
    body: { runId: "run-legacy", objective: "legacy", targetRoot: root },
  }, { modelRoot: root, harnessRoot: join(root, "runs"), now: () => at });
  assert.equal(prepared.status, 409);
});
