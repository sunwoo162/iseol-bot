import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectHistoryEvent, ProjectWorkspace, PrototypeCandidate } from "../src/project-model/contracts.js";
import {
  loadPrototypeCandidate,
  savePrototypeCandidate,
  updatePrototypeCandidate,
} from "../src/project-model/prototype-store.js";
import { loadProjectWorkspace, saveProjectWorkspace } from "../src/project-model/workspace-store.js";
import { appendProjectHistoryEvent, loadProjectHistory } from "../src/project-model/history-store.js";

function candidate(): PrototypeCandidate {
  return {
    version: 1,
    id: "prototype-001",
    title: "Study Race",
    concept: "Compete on study time",
    repository: { url: "https://github.com/example/repo", branch: "main", commitSha: "abc123" },
    deployment: { url: "https://study.example.com", provider: "vercel", deploymentId: "dpl_1" },
    runIds: ["run-001"],
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
      runs: [],
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
    }],
    createdAt: "2026-09-07T01:00:00.000Z",
    updatedAt: "2026-09-07T01:00:00.000Z",
  };
}

test("prototype store round trips and updates atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-project-model-"));
  await savePrototypeCandidate(root, candidate());
  assert.deepEqual(await loadPrototypeCandidate(root, "prototype-001"), candidate());

  const updated = await updatePrototypeCandidate(root, "prototype-001", {
    status: "archived",
    updatedAt: "2026-09-07T00:10:00.000Z",
  });
  assert.equal(updated?.status, "archived");
  assert.equal((await loadPrototypeCandidate(root, "prototype-001"))?.updatedAt, "2026-09-07T00:10:00.000Z");
});

test("workspace store round trips and missing ids return null", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-project-model-"));
  await saveProjectWorkspace(root, workspace());
  assert.deepEqual(await loadProjectWorkspace(root, "project-prototype-001"), workspace());
  assert.equal(await loadProjectWorkspace(root, "project-missing"), null);
  assert.equal(await loadPrototypeCandidate(root, "prototype-missing"), null);
});

test("project history is append-only and reloads in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-project-model-"));
  const first: ProjectHistoryEvent = {
    version: 1,
    id: "event-001",
    projectId: "project-prototype-001",
    type: "project-promoted",
    at: "2026-09-07T01:00:00.000Z",
    summary: "Promoted",
    prototypeId: "prototype-001",
  };
  const second: ProjectHistoryEvent = {
    version: 1,
    id: "event-002",
    projectId: "project-prototype-001",
    type: "genesis-run-imported",
    at: "2026-09-07T01:00:01.000Z",
    summary: "Imported run",
    runId: "run-001",
  };
  await appendProjectHistoryEvent(root, first);
  await appendProjectHistoryEvent(root, second);
  assert.deepEqual(await loadProjectHistory(root, "project-prototype-001"), [first, second]);
});

test("project model stores reject unsafe ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-project-model-"));
  await assert.rejects(loadPrototypeCandidate(root, "../escape"), /Invalid Iseol Project Model id/);
  await assert.rejects(loadProjectWorkspace(root, "../escape"), /Invalid Iseol Project Model id/);
  await assert.rejects(loadProjectHistory(root, "../escape"), /Invalid Iseol Project Model id/);
});
