import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessRuntimeRunEnvelope, HarnessRunEvent } from "../src/harness/contracts.js";
import { appendHarnessRunEvent } from "../src/harness/event-store.js";
import { saveHarnessRun } from "../src/harness/run-store.js";
import type { PrototypeCandidate } from "../src/project-model/contracts.js";
import { loadProjectHistory } from "../src/project-model/history-store.js";
import { promotePrototype } from "../src/project-model/promotion.js";
import { loadPrototypeCandidate, savePrototypeCandidate } from "../src/project-model/prototype-store.js";
import { loadProjectWorkspace } from "../src/project-model/workspace-store.js";

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

function runEnvelope(): HarnessRuntimeRunEnvelope {
  return {
    version: 1,
    request: {
      version: 1,
      runId: "run-001",
      mode: "idea-lab",
      objective: "Build Study Race prototype",
      targetRoot: "C:/repo",
    },
    preflight: {
      version: 1,
      runId: "run-001",
      status: "ready",
      policy: {
        version: 1,
        loadedAt: "2026-09-07T00:00:00.000Z",
        sources: [],
        effectiveSha256: "a".repeat(64),
      },
    },
    state: {
      version: 1,
      stage: "DONE",
      status: "DONE",
      completedStages: ["PREFLIGHT", "CONTEXT", "ANALYZE", "PLAN", "IMPLEMENT", "TEST"],
      skippedStages: [],
      updatedAt: "2026-09-07T00:30:00.000Z",
    },
    evidence: [{
      version: 1,
      id: "evidence-deploy",
      kind: "deployment",
      stage: "DEPLOY",
      recordedAt: "2026-09-07T00:20:00.000Z",
      summary: "Prototype deployed",
      reference: "dpl_1",
    }],
    updatedAt: "2026-09-07T00:30:00.000Z",
  };
}

function runEvent(): HarnessRunEvent {
  return {
    version: 1,
    id: "event-run-001",
    runId: "run-001",
    type: "stage-completed",
    at: "2026-09-07T00:20:00.000Z",
    stage: "DEPLOY",
    status: "RUNNING",
    summary: "Deployment completed",
    evidenceIds: ["evidence-deploy"],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "iseol-promotion-"));
  const modelRoot = join(root, "model");
  const harnessRoot = join(root, "runs");
  await savePrototypeCandidate(modelRoot, candidate());
  await saveHarnessRun(harnessRoot, runEnvelope());
  await appendHarnessRunEvent(harnessRoot, runEvent());
  return { modelRoot, harnessRoot };
}

test("promotion freezes prototype identity and imports Harness Genesis", async () => {
  const { modelRoot, harnessRoot } = await fixture();
  const promoted = await promotePrototype({
    modelRoot,
    harnessRoot,
    prototypeId: "prototype-001",
    promotedAt: "2026-09-07T01:00:00.000Z",
  });

  assert.equal(promoted.id, "project-prototype-001");
  assert.deepEqual(promoted.genesis.repository, candidate().repository);
  assert.deepEqual(promoted.genesis.deployment, candidate().deployment);
  assert.equal(promoted.genesis.runs.length, 1);
  assert.equal(promoted.genesis.runs[0]?.objective, "Build Study Race prototype");
  assert.equal(promoted.genesis.runs[0]?.policySha256, "a".repeat(64));
  assert.deepEqual(promoted.genesis.runs[0]?.events, [runEvent()]);
});

test("promotion marks candidate promoted and is idempotent on retry", async () => {
  const { modelRoot, harnessRoot } = await fixture();
  const input = {
    modelRoot,
    harnessRoot,
    prototypeId: "prototype-001",
    promotedAt: "2026-09-07T01:00:00.000Z",
  };

  const first = await promotePrototype(input);
  const second = await promotePrototype({ ...input, promotedAt: "2026-09-07T01:10:00.000Z" });
  assert.deepEqual(second, first);

  const savedCandidate = await loadPrototypeCandidate(modelRoot, "prototype-001");
  assert.equal(savedCandidate?.status, "promoted");
  assert.equal(savedCandidate?.promotedProjectId, first.id);

  const history = await loadProjectHistory(modelRoot, first.id);
  assert.equal(history.filter((event) => event.type === "project-promoted").length, 1);
  assert.equal(history.filter((event) => event.type === "genesis-run-imported").length, 1);
  assert.deepEqual(await loadProjectWorkspace(modelRoot, first.id), first);
});

test("missing Genesis Run aborts before promotion state is committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-promotion-missing-"));
  const modelRoot = join(root, "model");
  const harnessRoot = join(root, "runs");
  const broken = candidate();
  broken.runIds = ["run-missing"];
  await savePrototypeCandidate(modelRoot, broken);

  await assert.rejects(
    promotePrototype({
      modelRoot,
      harnessRoot,
      prototypeId: broken.id,
      promotedAt: "2026-09-07T01:00:00.000Z",
    }),
    /Genesis Run not found: run-missing/,
  );
  assert.equal((await loadPrototypeCandidate(modelRoot, broken.id))?.status, "candidate");
  assert.equal(await loadProjectWorkspace(modelRoot, "project-prototype-001"), null);
});
