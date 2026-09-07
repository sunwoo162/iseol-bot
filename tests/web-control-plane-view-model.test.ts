import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRuntimeRunEnvelope } from "../src/harness/contracts.js";
import { saveHarnessRun } from "../src/harness/run-store.js";
import type { ProjectWorkspace, PrototypeCandidate } from "../src/project-model/contracts.js";
import { appendProjectHistoryEvent } from "../src/project-model/history-store.js";
import { savePrototypeCandidate } from "../src/project-model/prototype-store.js";
import { saveProjectWorkspace } from "../src/project-model/workspace-store.js";
import {
  buildIdeaLabView,
  buildProjectWorkspaceView,
} from "../src/web-control-plane/view-model.js";

function candidate(): PrototypeCandidate {
  return {
    version: 1,
    id: "prototype-001",
    title: "Study Race",
    concept: "Compete on study time",
    repository: { url: "https://github.com/example/repo", branch: "main", commitSha: "abc123" },
    deployment: { url: "https://study.example.com", provider: "vercel", deploymentId: "dpl_1" },
    runIds: ["run-genesis"],
    status: "candidate",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

function workspace(): ProjectWorkspace {
  return {
    version: 1,
    id: "project-prototype-001",
    name: "Study Race",
    status: "active",
    genesis: {
      prototypeId: "prototype-001",
      repository: candidate().repository,
      deployment: candidate().deployment,
      runs: [{
        runId: "run-genesis",
        objective: "Build prototype",
        stage: "DONE",
        status: "DONE",
        policySha256: "a".repeat(64),
        evidence: [],
        events: [],
      }],
      promotedAt: "2026-09-07T01:00:00.000Z",
    },
    tree: [{
      id: "root",
      kind: "root",
      title: "Study Race",
      status: "in-progress",
      runIds: [],
      createdAt: "2026-09-07T01:00:00.000Z",
      updatedAt: "2026-09-07T01:00:00.000Z",
    }, {
      id: "profile",
      parentId: "root",
      kind: "feature",
      title: "Profile",
      status: "in-progress",
      runIds: ["run-active"],
      createdAt: "2026-09-07T01:10:00.000Z",
      updatedAt: "2026-09-07T01:10:00.000Z",
    }],
    createdAt: "2026-09-07T01:00:00.000Z",
    updatedAt: "2026-09-07T01:10:00.000Z",
  };
}

function activeRun(): HarnessRuntimeRunEnvelope {
  return {
    version: 1,
    request: {
      version: 1,
      runId: "run-active",
      mode: "project-workspace",
      objective: "Implement profile editing",
      targetRoot: "C:/repo",
    },
    preflight: {
      version: 1,
      runId: "run-active",
      status: "ready",
      policy: {
        version: 1,
        loadedAt: "2026-09-07T01:10:00.000Z",
        sources: [{
          kind: "iseol-global",
          path: "C:/secret/HARNESS_ENGINEERING.md",
          sha256: "b".repeat(64),
          content: "SECRET_POLICY_TEXT",
        }],
        effectiveSha256: "c".repeat(64),
      },
    },
    state: {
      version: 1,
      stage: "IMPLEMENT",
      status: "RUNNING",
      completedStages: ["PREFLIGHT", "CONTEXT", "ANALYZE", "PLAN"],
      skippedStages: [],
      updatedAt: "2026-09-07T01:20:00.000Z",
    },
    evidence: [],
    updatedAt: "2026-09-07T01:20:00.000Z",
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "iseol-web-view-"));
  const modelRoot = join(root, "model");
  const harnessRoot = join(root, "runs");
  await savePrototypeCandidate(modelRoot, candidate());
  await saveProjectWorkspace(modelRoot, workspace());
  await saveHarnessRun(harnessRoot, activeRun());
  await appendProjectHistoryEvent(modelRoot, {
    version: 1,
    id: "history-001",
    projectId: "project-prototype-001",
    type: "run-attached",
    at: "2026-09-07T01:10:00.000Z",
    summary: "Attached profile run",
    nodeId: "profile",
    runId: "run-active",
  });
  return { modelRoot, harnessRoot };
}

test("Idea Lab view exposes prototype experience metadata", async () => {
  const { modelRoot } = await fixture();
  const view = await buildIdeaLabView(modelRoot);
  assert.equal(view.prototypes.length, 1);
  assert.equal(view.prototypes[0]?.title, "Study Race");
  assert.equal(view.prototypes[0]?.deployment.url, "https://study.example.com");
  assert.equal(view.prototypes[0]?.status, "candidate");
});

test("Project Workspace view exposes Genesis tree history and active Run summary", async () => {
  const { modelRoot, harnessRoot } = await fixture();
  const view = await buildProjectWorkspaceView(modelRoot, harnessRoot, "project-prototype-001");
  assert.ok(view);
  assert.equal(view.project.name, "Study Race");
  assert.equal(view.genesis.prototypeId, "prototype-001");
  assert.equal(view.tree.find((node) => node.id === "profile")?.runIds[0], "run-active");
  assert.equal(view.history[0]?.id, "history-001");
  assert.equal(view.runs[0]?.runId, "run-active");
  assert.equal(view.runs[0]?.stage, "IMPLEMENT");
  assert.equal(view.runs[0]?.policySha256, "c".repeat(64));
});

test("Web view model does not expose policy source contents or environment values", async () => {
  const { modelRoot, harnessRoot } = await fixture();
  process.env.ISEOL_TEST_SECRET = "SECRET_ENV_VALUE";
  const view = await buildProjectWorkspaceView(modelRoot, harnessRoot, "project-prototype-001");
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("SECRET_POLICY_TEXT"), false);
  assert.equal(serialized.includes("C:/secret/HARNESS_ENGINEERING.md"), false);
  assert.equal(serialized.includes("SECRET_ENV_VALUE"), false);
  delete process.env.ISEOL_TEST_SECRET;
});

test("missing Project Workspace returns null", async () => {
  const { modelRoot, harnessRoot } = await fixture();
  assert.equal(
    await buildProjectWorkspaceView(modelRoot, harnessRoot, "project-missing"),
    null,
  );
});
