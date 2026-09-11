import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createIdeaLabProductionRuntimeDriver } from "../src/idea-lab/production-runtime-driver.js";
import type { IdeaProposal } from "../src/idea-lab/contracts.js";
import { saveHarnessRun } from "../src/harness/run-store.js";
import { listPrototypeCandidates } from "../src/project-model/prototype-store.js";
import type { HarnessRuntimeRunEnvelope } from "../src/harness/contracts.js";
import { saveIdeaProposal } from "../src/idea-lab/proposal-store.js";
import { createFakePrototypeDeployAdapter } from "../src/idea-lab/test-support/fake-deploy-adapter.js";
import { loadPrototypeCandidate } from "../src/project-model/prototype-store.js";
import { loadPrototypeProduction } from "../src/idea-lab/production-store.js";

test("createProduction is durable and reconciles the same Run and sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-"));
  const calls: string[] = [];
  const proposal: IdeaProposal = {
    version: 1, id: "proposal-1", campaignId: "camp-1", title: "Focus Garden", concept: "Focus",
    problemDomain: "study", targetUser: "students", jobToBeDone: "focus", coreInteractionLoop: "plan-review",
    dataModel: "sessions", primaryDifferentiator: "feedback", whyMateriallyDifferent: "loop", status: "accepted",
    createdAt: "2026-09-11T00:00:00.000Z",
  };
  const sandbox = {
    inspect: async () => null,
    allocate: async (input: { run: { request: { targetRoot: string } } }) => {
      calls.push(input.run.request.targetRoot);
      return { repositoryUrl: "https://github.com/acme/proto", branch: "idea/camp-1/camp-1-prod-1", worktreeRoot: input.run.request.targetRoot, baseRef: "main" };
    },
  };
  const driver = createIdeaLabProductionRuntimeDriver({
    roots: { iseolRoot: root, modelRoot: root, runRoot: root, webRoot: root, browserProfileRoot: root },
    repositoryRoot: root, repositoryUrl: "https://github.com/acme/proto", baseRef: "main", sandboxRoot: root,
    agentId: "agent-1", sandboxAdapter: sandbox, desktopTransport: {} as never, browserAdapter: {} as never,
    desktopStateRoot: root,
    desktopTaskCompiler: async () => null,
    deployAdapter: {} as never,
  });
  const first = await driver.createProduction(proposal, 1);
  const second = await driver.createProduction(proposal, 1);
  assert.equal(first.id, "camp-1-prod-1");
  assert.equal(first.runId, "run-camp-1-prod-1");
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1);
  assert.equal(resolve(root, "camp-1", first.id), resolve(root, "camp-1", first.id));
});

test("uses configured target identity and desktop state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-target-"));
  const seen: unknown[] = [];
  const proposal = { ...baseProposal("camp-target"), id: "proposal-target" };
  const driver = makeDriver(root, {
    proposal,
    repositoryRoot: root + "-repo", repositoryUrl: "https://github.com/acme/target", baseRef: "develop", desktopStateRoot: join(root, "desktop-state"),
    sandbox: { inspect: async (input: any) => { seen.push(input); return null; }, allocate: async (input: any) => ({ repositoryUrl: input.repositoryUrl, branch: "idea/camp-target/camp-target-prod-1", worktreeRoot: input.run.request.targetRoot, baseRef: input.baseRef }) },
  });
  await driver.createProduction(proposal, 1);
  assert.equal((seen[0] as any).repositoryRoot, root + "-repo");
  assert.equal((seen[0] as any).repositoryUrl, "https://github.com/acme/target");
  assert.equal((seen[0] as any).baseRef, "develop");
  assert.equal((seen[0] as any).agentId, "agent-1");
  assert.equal((seen[0] as any).run.request.targetRoot, resolve(root, "camp-target", "camp-target-prod-1"));
});

test("createProduction preserves an advanced canonical Run without reallocating", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-advanced-"));
  const proposal = baseProposal("camp-advanced"); let allocations = 0;
  const driver = makeDriver(root, { proposal, sandbox: { inspect: async () => null, allocate: async (input: any) => { allocations++; return { repositoryUrl: input.repositoryUrl, branch: "idea/camp-advanced/camp-advanced-prod-1", worktreeRoot: input.run.request.targetRoot, baseRef: input.baseRef }; } } });
  const first = await driver.createProduction(proposal, 1); const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, first.runId); await saveHarnessRun(root, { ...run!, state: { ...run!.state, stage: "TEST", status: "READY", completedStages: ["CONTEXT", "ANALYZE", "PLAN", "IMPLEMENT", "TEST"] } });
  const second = await driver.createProduction(proposal, 1); const saved = await loadHarnessRun(root, first.runId);
  assert.equal(second.runId, first.runId); assert.equal(saved?.state.status, "READY"); assert.equal(allocations, 1);
});

test("rejects a mismatched canonical Run before allocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-run-mismatch-")); const proposal = baseProposal("camp-run-mismatch"); let allocations = 0;
  const driver = makeDriver(root, { proposal, sandbox: { inspect: async () => null, allocate: async (input: any) => { allocations++; return { repositoryUrl: input.repositoryUrl, branch: "idea/camp-run-mismatch/camp-run-mismatch-prod-1", worktreeRoot: input.run.request.targetRoot, baseRef: input.baseRef }; } } });
  const first = await driver.createProduction(proposal, 1); const { loadHarnessRun, saveHarnessRun } = await import("../src/harness/run-store.js"); const original = await loadHarnessRun(root, first.runId); await saveHarnessRun(root, { ...original!, request: { ...original!.request, objective: "wrong", targetRoot: join(root, "wrong") } });
  await assert.rejects(() => driver.createProduction(proposal, 1), /Run identity mismatch/i); assert.equal(allocations, 1);
});

test("rejects a Run whose internal runId disagrees with its canonical path", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-run-id-mismatch-"));
  const proposal = baseProposal("camp-run-id-mismatch");
  const driver = makeDriver(root, { proposal });
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  assert.ok(run);
  const corrupted = { ...run, request: { ...run.request, runId: "run-other" } };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(join(root, production.runId, "run.json"), JSON.stringify(corrupted, null, 2), "utf8"));
  await assert.rejects(() => driver.createProduction(proposal, 1), /Run identity mismatch/i);
  await assert.rejects(() => driver.advanceProduction(production), /Run identity mismatch/i);
});
test("missing proposal and missing Run fail closed independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-missing-")); const proposal = baseProposal("camp-missing"); const driver = makeDriver(root, { proposal });
  const production = await driver.createProduction(proposal, 1); await assert.rejects(() => driver.advanceProduction({ ...production, proposalId: "missing-proposal" }), /dependency is missing/);
  await saveIdeaProposal(root, proposal); const { loadHarnessRun } = await import("../src/harness/run-store.js"); const run = await loadHarnessRun(root, production.runId); await import("node:fs/promises").then(({ rm }) => rm(join(root, production.runId, "run.json"), { force: true }));
  assert.ok(run); await assert.rejects(() => driver.advanceProduction(production), /dependency is missing/);
});

test("FAILED_FINAL is persisted and sanitized", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-failed-")); const proposal = baseProposal("camp-failed"); const driver = makeDriver(root, { proposal }); const production = await driver.createProduction(proposal, 1); await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js"); const run = await loadHarnessRun(root, production.runId); await saveHarnessRun(root, { ...run!, state: { ...run!.state, status: "FAILED_FINAL", reason: "SECRET_TOKEN failure" } });
  const result = await driver.advanceProduction(production); const loaded = await loadPrototypeProduction(root, production.id); assert.equal(result.status, "failed"); assert.equal(loaded?.status, "failed"); assert.ok(result.failureSummary && result.failureSummary.length < 120); assert.ok(!JSON.stringify(result).includes("SECRET_TOKEN"));
});

test("lost deploy response recovers once and materializes persisted candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-lost-")); const proposal = baseProposal("camp-lost"); const fake = createFakePrototypeDeployAdapter({ loseFirstResponse: true, now: () => "2026-09-11T00:00:00.000Z" }); const driver = makeDriver(root, { proposal, deployAdapter: fake }); const production = await driver.createProduction(proposal, 1); await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js"); const run = await loadHarnessRun(root, production.runId); const sha = "c".repeat(40); await saveHarnessRun(root, { ...run!, preflight: { version: 1, runId: run!.request.runId, status: "ready", policy: { version: 1, loadedAt: "now", sources: [], effectiveSha256: "policy" } }, state: { ...run!.state, stage: "DEPLOY", status: "READY", completedStages: ["CONTEXT", "ANALYZE", "PLAN", "IMPLEMENT", "TEST", "SELF_REVIEW", "COMMIT"] }, evidence: [{ version: 1, id: "test", kind: "test", stage: "TEST", recordedAt: "now", summary: "tested" }, { version: 1, id: "review", kind: "review", stage: "SELF_REVIEW", recordedAt: "now", summary: "reviewed" }, { version: 1, id: "commit", kind: "commit", stage: "COMMIT", recordedAt: "now", summary: "committed", reference: sha }] });
  const result = await driver.advanceProduction(production); const saved = await loadPrototypeProduction(root, production.id); assert.equal(result.status, "ready"); assert.equal(fake.deployCalls.length, 1); assert.equal(saved?.id, production.id); assert.equal((await loadPrototypeCandidate(root, production.id))?.ideaLabOrigin?.productionId, production.id);
});

test("existing Production with missing canonical Run fails closed without recreating Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-missing-run-reuse-"));
  const proposal = baseProposal("camp-missing-run-reuse");
  let allocations = 0;
  const driver = makeDriver(root, { proposal, sandbox: {
    inspect: async () => null,
    allocate: async (input: any) => {
      allocations += 1;
      return { repositoryUrl: input.repositoryUrl, branch: "idea/camp-missing-run-reuse/camp-missing-run-reuse-prod-1", worktreeRoot: input.run.request.targetRoot, baseRef: input.baseRef };
    },
  } });
  const production = await driver.createProduction(proposal, 1);
  await import("node:fs/promises").then(({ rm }) => rm(join(root, production.runId, "run.json"), { force: true }));
  await assert.rejects(() => driver.createProduction(proposal, 1), /Run.*missing|dependency is missing/i);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  assert.equal(await loadHarnessRun(root, production.runId), null);
  assert.equal(allocations, 1);
});
test("rejects a mismatched existing production identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-mismatch-"));
  const proposal = baseProposal("camp-mismatch");
  const driver = makeDriver(root, { proposal });
  const first = await driver.createProduction(proposal, 1);
  await (await import("../src/idea-lab/production-store.js")).savePrototypeProduction(root, { ...first, branch: "wrong" });
  await assert.rejects(() => driver.createProduction(proposal, 1), /identity mismatch/i);
});

test("pre-completed DONE Run deploys once, materializes one candidate, and is ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-done-"));
  const proposal = baseProposal("camp-done");
  let deploys = 0;
  const sha = "a".repeat(40);
  const driver = makeDriver(root, { proposal, deployAdapter: {
    reconcile: async () => null,
    deploy: async (request: any) => { deploys += 1; return { provider: "test", deploymentId: "d1", url: "https://preview", commitSha: request.commitSha, deployedAt: "2026-09-11T00:00:00.000Z" }; },
    verify: async (request: any) => ({ ...request.deployment, verifiedAt: "2026-09-11T00:00:00.000Z" }),
  }});
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const run = await import("../src/harness/run-store.js").then(({ loadHarnessRun }) => loadHarnessRun(root, production.runId));
  assert.ok(run);
  const done: HarnessRuntimeRunEnvelope = { ...run!, state: { ...run!.state, stage: "DONE", status: "DONE", completedStages: ["CONTEXT", "ANALYZE", "PLAN", "IMPLEMENT", "TEST", "SELF_REVIEW", "COMMIT", "DEPLOY", "PRODUCTION_VERIFY"], updatedAt: "now" }, evidence: [
    { version: 1, id: "commit", kind: "commit", stage: "COMMIT", recordedAt: "now", summary: "committed", reference: sha },
    { version: 1, id: "test", kind: "test", stage: "TEST", recordedAt: "now", summary: "tested" },
    { version: 1, id: "review", kind: "review", stage: "SELF_REVIEW", recordedAt: "now", summary: "reviewed" },
    { version: 1, id: "deploy", kind: "deployment", stage: "DEPLOY", recordedAt: "now", summary: "deployed", reference: "https://preview" },
    { version: 1, id: "verify", kind: "production-verification", stage: "PRODUCTION_VERIFY", recordedAt: "now", summary: "verified", reference: "https://preview" },
  ] };
  await saveHarnessRun(root, { ...done, preflight: { version: 1, runId: done.request.runId, status: "ready", policy: { version: 1, loadedAt: "now", sources: [], effectiveSha256: "policy" } } });
  const ready = await driver.advanceProduction(production);
  assert.equal(ready.status, "ready");
  assert.equal(ready.commitSha, sha);
  assert.equal(deploys, 1);
  assert.equal((await listPrototypeCandidates(root)).length, 1);
});

test("missing COMMIT evidence fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-commit-"));
  const proposal = baseProposal("camp-commit");
  const driver = makeDriver(root, { proposal });
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  await saveHarnessRun(root, { ...run!, preflight: { version: 1, runId: run!.request.runId, status: "ready", policy: { version: 1, loadedAt: "now", sources: [], effectiveSha256: "policy" } }, state: { ...run!.state, stage: "DONE", status: "DONE", completedStages: ["COMMIT", "DEPLOY", "PRODUCTION_VERIFY"] }, evidence: [] });
  await assert.rejects(() => driver.advanceProduction(production), /COMMIT evidence/i);
});

test("provider failure returns bounded generic failure without provider text", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-safe-"));
  const proposal = baseProposal("camp-safe");
  const driver = makeDriver(root, { proposal, deployAdapter: { reconcile: async () => null, deploy: async () => { throw new Error("SECRET_PROVIDER_TOKEN"); }, verify: async () => { throw new Error("SECRET_PROVIDER_TOKEN"); } } });
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  const sha = "b".repeat(40);
  await saveHarnessRun(root, { ...run!, preflight: { version: 1, runId: run!.request.runId, status: "ready", policy: { version: 1, loadedAt: "now", sources: [], effectiveSha256: "policy" } }, state: { ...run!.state, stage: "DEPLOY", status: "READY", completedStages: ["CONTEXT", "ANALYZE", "PLAN", "IMPLEMENT", "TEST", "SELF_REVIEW", "COMMIT"] }, evidence: [{ version: 1, id: "test", kind: "test", stage: "TEST", recordedAt: "now", summary: "tested" }, { version: 1, id: "review", kind: "review", stage: "SELF_REVIEW", recordedAt: "now", summary: "reviewed" }, { version: 1, id: "commit", kind: "commit", stage: "COMMIT", recordedAt: "now", summary: "committed", reference: sha }] });
  const result = await driver.advanceProduction(production);
  assert.equal(result.status, "running");
  assert.ok(!JSON.stringify(result).includes("SECRET_PROVIDER_TOKEN"));
});

function baseProposal(campaignId: string): IdeaProposal {
  return { version: 1, id: `proposal-${campaignId}`, campaignId, title: "Focus", concept: "Focus", problemDomain: "study", targetUser: "students", jobToBeDone: "focus", coreInteractionLoop: "plan", dataModel: "sessions", primaryDifferentiator: "feedback", whyMateriallyDifferent: "loop", status: "accepted", createdAt: "2026-09-11T00:00:00.000Z" };
}

function makeDriver(root: string, options: any = {}) {
  const proposal = options.proposal ?? baseProposal("camp-1");
  const repositoryRoot = options.repositoryRoot ?? root;
  return createIdeaLabProductionRuntimeDriver({
    roots: { iseolRoot: root, modelRoot: root, runRoot: root, webRoot: root, browserProfileRoot: root },
    repositoryRoot, repositoryUrl: options.repositoryUrl ?? "https://github.com/acme/proto", baseRef: options.baseRef ?? "main", sandboxRoot: root,
    agentId: "agent-1", desktopStateRoot: options.desktopStateRoot ?? root, sandboxAdapter: options.sandbox ?? { inspect: async () => null, allocate: async (input: any) => ({ repositoryUrl: input.repositoryUrl, branch: `idea/${input.campaignId}/${input.productionId}`, worktreeRoot: input.run.request.targetRoot, baseRef: input.baseRef }) }, desktopTransport: {} as never, browserAdapter: {} as never,
    desktopTaskCompiler: async () => null, deployAdapter: options.deployAdapter ?? {} as never,
  });
}
