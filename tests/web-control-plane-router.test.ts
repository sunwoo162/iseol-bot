import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrototypeCandidate } from "../src/project-model/contracts.js";
import { savePrototypeCandidate } from "../src/project-model/prototype-store.js";
import { loadProjectWorkspace } from "../src/project-model/workspace-store.js";
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
