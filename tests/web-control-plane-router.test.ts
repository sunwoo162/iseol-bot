import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrototypeCandidate } from "../src/project-model/contracts.js";
import { savePrototypeCandidate } from "../src/project-model/prototype-store.js";
import { loadProjectWorkspace } from "../src/project-model/workspace-store.js";
import { saveProjectWorkspace } from "../src/project-model/workspace-store.js";
import { routeWebControlPlaneRequest } from "../src/web-control-plane/router.js";

function candidate(): PrototypeCandidate {
  return {
    version: 1,
    id: "prototype-001",
    title: "Study Race",
    concept: "Compete on study time",
    repository: { url: "https://github.com/example/repo", branch: "main", commitSha: "abc123" },
    deployment: { url: "https://study.example.com" },
    runIds: [],
    status: "candidate",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

async function fixture(token = "") {
  const root = await mkdtemp(join(tmpdir(), "iseol-web-router-"));
  const modelRoot = join(root, "model");
  const harnessRoot = join(root, "runs");
  await savePrototypeCandidate(modelRoot, candidate());
  return { modelRoot, harnessRoot, token };
}

test("routes Idea Lab and missing project reads", async () => {
  const deps = await fixture();
  const idea = await routeWebControlPlaneRequest(
    { method: "GET", path: "/api/idea-lab", headers: {} },
    deps,
  );
  assert.equal(idea.status, 200);
  assert.equal((idea.body as any).prototypes[0].id, "prototype-001");

  const missing = await routeWebControlPlaneRequest(
    { method: "GET", path: "/api/projects/project-missing", headers: {} },
    deps,
  );
  assert.equal(missing.status, 404);
});

test("routes prototype and campaign detail reads without mutation", async () => {
  const deps = await fixture();
  const prototype = await routeWebControlPlaneRequest(
    { method: "GET", path: "/api/prototypes/prototype-001", headers: {} },
    deps,
  );
  assert.equal(prototype.status, 200);
  assert.equal((prototype.body as any).prototype.id, "prototype-001");
  const missingCampaign = await routeWebControlPlaneRequest(
    { method: "GET", path: "/api/idea-lab/campaigns/missing", headers: {} },
    deps,
  );
  assert.equal(missingCampaign.status, 404);
});

test("work request API persists idempotent queue entries and exposes claims", async () => {
  const deps = await fixture("secret-token");
  await saveProjectWorkspace(deps.modelRoot, {
    version: 1, id: "project-queue", name: "Queue", status: "active",
    genesis: { prototypeId: "prototype-001", repository: candidate().repository, deployment: candidate().deployment, runs: [], promotedAt: "2026-09-07T00:00:00.000Z" },
    tree: [{ id: "root", kind: "root", title: "Queue", status: "planned", runIds: [], createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z" }],
    createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
  });
  const create = await routeWebControlPlaneRequest({ method: "POST", path: "/api/projects/project-queue/work-requests", headers: { authorization: "Bearer secret-token" }, body: { title: "Implement queue", objective: "Build durable queue", idempotencyKey: "queue-1" } }, deps);
  assert.equal(create.status, 201);
  const repeat = await routeWebControlPlaneRequest({ method: "POST", path: "/api/projects/project-queue/work-requests", headers: { authorization: "Bearer secret-token" }, body: { title: "Implement queue", objective: "Build durable queue", idempotencyKey: "queue-1" } }, deps);
  assert.equal(repeat.status, 200);
  assert.equal((repeat.body as any).id, (create.body as any).id);
  const list = await routeWebControlPlaneRequest({ method: "GET", path: "/api/projects/project-queue/work-requests", headers: {} }, deps);
  assert.equal(list.status, 200);
  assert.equal((list.body as any).requests.length, 1);
});

test("rejects unsupported methods and malformed project paths", async () => {
  const deps = await fixture();
  const method = await routeWebControlPlaneRequest(
    { method: "DELETE", path: "/api/idea-lab", headers: {} },
    deps,
  );
  assert.equal(method.status, 405);

  const traversal = await routeWebControlPlaneRequest(
    { method: "GET", path: "/api/projects/%2E%2E%2Fescape", headers: {} },
    deps,
  );
  assert.equal(traversal.status, 404);
});

test("promotion requires configured bearer token", async () => {
  const deps = await fixture("secret-token");
  const missing = await routeWebControlPlaneRequest(
    { method: "POST", path: "/api/prototypes/prototype-001/promote", headers: {} },
    deps,
  );
  assert.equal(missing.status, 401);

  const wrong = await routeWebControlPlaneRequest(
    {
      method: "POST",
      path: "/api/prototypes/prototype-001/promote",
      headers: { authorization: "Bearer wrong-token" },
    },
    deps,
  );
  assert.equal(wrong.status, 401);
});

test("promotion returns canonical Project Workspace and persists it", async () => {
  const deps = await fixture("secret-token");
  const response = await routeWebControlPlaneRequest(
    {
      method: "POST",
      path: "/api/prototypes/prototype-001/promote",
      headers: { authorization: "Bearer secret-token" },
    },
    { ...deps, now: () => "2026-09-07T02:00:00.000Z" },
  );

  assert.equal(response.status, 200);
  assert.equal((response.body as any).id, "project-prototype-001");
  assert.ok(await loadProjectWorkspace(deps.modelRoot, "project-prototype-001"));
});

test("operator reconciliation separates inspection from approved mutation", async () => {
  const deps = await fixture("secret-token");
  const inspection = { projectId: "project-a", runId: "run-3", canReconcile: true, blockers: [] };
  const runtime = {
    state: "ready" as const,
    inspectProjectRunReconciliation: async () => inspection,
    reconcileProjectRun: async () => ({ status: "reconciled", operationId: "op-1" }),
    issueProjectRunOperatorApproval: async () => ({ approvalId: "approval-1", status: "issued" }),
  };
  const denied = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/runs/run-3/operator-reconciliation", headers: { authorization: "Bearer secret-token" },
    body: { action: "apply", expectedRevision: "r", operationId: "op-1", reason: "stale-runtime-after-shutdown" },
  }, { ...deps, operatorToken: "operator-token", operatorId: "test-operator", ideaLabRuntime: runtime });
  assert.equal(denied.status, 403);
  const checked = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/runs/run-3/operator-reconciliation", headers: { authorization: "Bearer secret-token" },
    body: { action: "inspect", expectedRevision: "r" },
  }, { ...deps, operatorToken: "operator-token", operatorId: "test-operator", ideaLabRuntime: runtime });
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.body, inspection);
  const applied = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/runs/run-3/operator-reconciliation", headers: { authorization: "Bearer operator-token" },
    body: { action: "apply", expectedRevision: "r", operationId: "op-1", reason: "stale-runtime-after-shutdown", approval: { actor: "operator", approvalId: "approval-1" } },
  }, { ...deps, operatorToken: "operator-token", operatorId: "test-operator", ideaLabRuntime: runtime });
  assert.equal(applied.status, 200);
  const missingIdentity = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/runs/run-3/operator-approvals", headers: { authorization: "Bearer operator-token" },
    body: { requestId: "request-missing-identity", expectedRevision: "r", reason: "stale-runtime-after-shutdown" },
  }, { ...deps, operatorToken: "operator-token", ideaLabRuntime: runtime });
  assert.equal(missingIdentity.status, 401);
  const issued = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/runs/run-3/operator-approvals", headers: { authorization: "Bearer operator-token" },
    body: { requestId: "request-1", expectedRevision: "r", reason: "stale-runtime-after-shutdown" },
  }, { ...deps, operatorToken: "operator-token", operatorId: "test-operator", ideaLabRuntime: runtime });
  assert.equal(issued.status, 201);
});

test("desktop job containment route is operator-gated and does not dispatch", async () => {
  const deps = await fixture("secret-token");
  const calls: string[] = [];
  const runtime = {
    state: "ready" as const,
    inspectDesktopJobReconciliation: async () => ({ jobId: "job-1", canContain: true, status: "pending" }),
    issueDesktopJobContainmentApproval: async () => ({ approvalId: "desktop-approval-1", status: "issued" }),
    containDesktopJob: async () => { calls.push("contain"); return { status: "contained" }; },
  };
  const denied = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/desktop-jobs/job-1/operator-reconciliation",
    headers: { authorization: "Bearer secret-token" }, body: { action: "inspect" },
  }, { ...deps, operatorToken: "operator-token", operatorId: "operator", ideaLabRuntime: runtime });
  assert.equal(denied.status, 403);
  const inspected = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/desktop-jobs/job-1/operator-reconciliation",
    headers: { authorization: "Bearer operator-token" }, body: { action: "inspect" },
  }, { ...deps, operatorToken: "operator-token", operatorId: "operator", ideaLabRuntime: runtime });
  assert.equal(inspected.status, 200);
  const contained = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/desktop-jobs/job-1/operator-reconciliation",
    headers: { authorization: "Bearer operator-token" }, body: { action: "contain", expectedRevision: "r", operationId: "op", approvalId: "a" },
  }, { ...deps, operatorToken: "operator-token", operatorId: "operator", ideaLabRuntime: runtime });
  assert.equal(contained.status, 200);
  assert.deepEqual(calls, ["contain"]);
  const approval = await routeWebControlPlaneRequest({
    method: "POST", path: "/api/projects/project-a/desktop-jobs/job-1/operator-approvals",
    headers: { authorization: "Bearer operator-token" }, body: { requestId: "req", expectedRevision: "r" },
  }, { ...deps, operatorToken: "operator-token", operatorId: "operator", ideaLabRuntime: runtime });
  assert.equal(approval.status, 201);
});
