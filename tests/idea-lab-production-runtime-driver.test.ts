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
import { loadPrototypeProduction, savePrototypeProduction } from "../src/idea-lab/production-store.js";
import { createFakeChatGptWebBrowserAdapter } from "../src/chatgpt-web/test-support/fake-browser-adapter.js";
import { loadDesktopIntent } from "../src/chatgpt-web/intent-store.js";

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
  const failed = await driver.advanceProduction(production);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureSummary, "Harness production failed");
});

test("unknown provider failure fails closed with bounded generic text", async () => {
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
  assert.equal(result.status, "failed");
  assert.ok(!JSON.stringify(result).includes("SECRET_PROVIDER_TOKEN"));
});

test("PRODUCTION_VERIFY reuses the persisted deployment without a second deploy", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-verify-reuse-"));
  const proposal = baseProposal("camp-verify-reuse");
  let deploys = 0;
  const driver = makeDriver(root, { proposal, deployAdapter: {
    reconcile: async () => null,
    deploy: async (request: any) => {
      deploys += 1;
      return { provider: "test", deploymentId: `d${deploys}`, url: "https://preview", commitSha: request.commitSha, deployedAt: "2026-09-12T00:00:00.000Z" };
    },
    verify: async (request: any) => ({ ...request.deployment, verifiedAt: "2026-09-12T00:00:01.000Z" }),
  }});
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  const sha = "d".repeat(40);
  await saveHarnessRun(root, runnableAtDeploy(run!, sha));
  const ready = await driver.advanceProduction(production);
  assert.equal(ready.status, "ready");
  assert.equal(deploys, 1);
});

test("deployment identity mismatch fails final instead of retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-provider-identity-"));
  const proposal = baseProposal("camp-provider-identity");
  let reconciles = 0;
  const driver = makeDriver(root, { proposal, deployAdapter: {
    reconcile: async (request: any) => {
      reconciles += 1;
      return { provider: "test", deploymentId: "foreign", url: "https://preview", commitSha: "e".repeat(40), deployedAt: "2026-09-12T00:00:00.000Z" };
    },
    deploy: async () => { throw new Error("must not deploy"); },
    verify: async () => { throw new Error("must not verify"); },
  }});
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  await saveHarnessRun(root, runnableAtDeploy(run!, "f".repeat(40)));
  const failed = await driver.advanceProduction(production);
  assert.equal(failed.status, "failed");
  assert.equal(reconciles, 1);
});

test("provider stage missing canonical commit fails the Production final", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-provider-commit-"));
  const proposal = baseProposal("camp-provider-commit");
  const driver = makeDriver(root, { proposal });
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  const broken = runnableAtDeploy(run!, "a".repeat(40));
  broken.evidence = broken.evidence.filter((item) => item.kind !== "commit");
  await saveHarnessRun(root, broken);
  const failed = await driver.advanceProduction(production);
  assert.equal(failed.status, "failed");
});

test("DONE finalization fails closed on deployment commit mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-finalize-mismatch-"));
  const proposal = baseProposal("camp-finalize-mismatch");
  const driver = makeDriver(root, { proposal, deployAdapter: {
    reconcile: async () => null,
    deploy: async () => ({ provider: "test", deploymentId: "bad", url: "https://preview", commitSha: "0".repeat(40), deployedAt: "2026-09-12T00:00:00.000Z" }),
    verify: async (request: any) => ({ ...request.deployment, verifiedAt: "2026-09-12T00:00:01.000Z" }),
  }});
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  await saveHarnessRun(root, completedRun(run!, "9".repeat(40)));
  const failed = await driver.advanceProduction(production);
  assert.equal(failed.status, "failed");
});

test("DONE finalization rejects persisted deployment for a different commit without redeploying", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-persisted-deploy-mismatch-"));
  const proposal = baseProposal("camp-persisted-deploy-mismatch");
  let deploys = 0;
  const driver = makeDriver(root, { proposal, deployAdapter: {
    reconcile: async () => null,
    deploy: async (request: any) => {
      deploys += 1;
      return { provider: "test", deploymentId: "new", url: "https://new-preview", commitSha: request.commitSha, deployedAt: "2026-09-12T00:00:00.000Z" };
    },
    verify: async (request: any) => ({ ...request.deployment, verifiedAt: "2026-09-12T00:00:01.000Z" }),
  }});
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  await savePrototypeProduction(root, {
    ...production,
    commitSha: "8".repeat(40),
    deployment: { provider: "test", deploymentId: "old", url: "https://old-preview", commitSha: "8".repeat(40), deployedAt: "2026-09-11T00:00:00.000Z" },
    status: "verifying",
  });
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  await saveHarnessRun(root, completedRun(run!, "9".repeat(40)));
  const failed = await driver.advanceProduction(production);
  assert.equal(failed.status, "failed");
  assert.equal(deploys, 0);
});

test("ambiguous canonical COMMIT evidence fails final before deployment", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-ambiguous-commit-"));
  const proposal = baseProposal("camp-ambiguous-commit");
  let deploys = 0;
  const driver = makeDriver(root, { proposal, deployAdapter: {
    reconcile: async () => null,
    deploy: async (request: any) => {
      deploys += 1;
      return { provider: "test", deploymentId: "d", url: "https://preview", commitSha: request.commitSha, deployedAt: "2026-09-12T00:00:00.000Z" };
    },
    verify: async (request: any) => ({ ...request.deployment, verifiedAt: "2026-09-12T00:00:01.000Z" }),
  }});
  const production = await driver.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  const ambiguous = runnableAtDeploy(run!, "1".repeat(40));
  ambiguous.evidence.push({ version: 1, id: "commit-ambiguous", kind: "commit", stage: "COMMIT", recordedAt: "later", summary: "other commit", reference: "2".repeat(40) });
  await saveHarnessRun(root, ambiguous);
  const failed = await driver.advanceProduction(production);
  assert.equal(failed.status, "failed");
  assert.equal(deploys, 0);
});


test("Idea Lab Web reasoning rejects commit intents before the canonical COMMIT stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-web-commit-"));
  const proposal = baseProposal("camp-web-commit");
  const bootstrap = makeDriver(root, { proposal });
  const production = await bootstrap.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  assert.ok(run);

  const runId = production.runId;
  const intentId = "web-commit-intent";
  const policySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const browser = createFakeChatGptWebBrowserAdapter([
    {
      version: 1, runId, stage: "IMPLEMENT", generation: 1, summary: "Commit too early", decisions: [], outcome: "continue",
      intents: [{
        version: 1, intentId, runId, stage: "IMPLEMENT", workspaceRoot: production.worktreeRoot, policySha256,
        kind: "REQUEST_COMMIT", cwd: ".", message: "feat: premature web commit",
      }],
    },
    {
      version: 1, runId, stage: "IMPLEMENT", generation: 1, summary: "Controlled stop", decisions: [], intents: [],
      outcome: "blocked-user", blockerReason: "stop after commit rejection",
    },
  ]);
  const driver = makeDriver(root, { proposal, browserAdapter: browser.adapter });
  await saveHarnessRun(root, {
    ...run,
    preflight: { version: 1, runId, status: "ready", policy: { version: 1, loadedAt: "now", sources: [], effectiveSha256: policySha256 } },
    state: { ...run.state, stage: "IMPLEMENT", status: "READY", completedStages: ["CONTEXT", "ANALYZE", "PLAN"] },
  });

  await driver.advanceProduction(production);

  const record = await loadDesktopIntent(root, runId, intentId);
  assert.equal(record?.status, "rejected");
  assert.match(record?.reason ?? "", /commit is not explicitly authorized/i);
});

test("Idea Lab restart hydrates completed Desktop output without rerunning the intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-web-recovery-feedback-"));
  const proposal = baseProposal("camp-web-recovery-feedback");
  const bootstrap = makeDriver(root, { proposal });
  const production = await bootstrap.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const run = await loadHarnessRun(root, production.runId);
  assert.ok(run);
  const runId = production.runId;
  const intentId = "analyze-read-package";
  const policySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const at = "2026-09-14T11:00:00.000Z";
  const intent = { version: 1 as const, intentId, runId, stage: "ANALYZE" as const, workspaceRoot: production.worktreeRoot, policySha256, kind: "READ_CONTEXT" as const, path: "package.json" };
  const { appendReasoningTurn } = await import("../src/chatgpt-web/turn-store.js");
  const { recordDesktopIntent } = await import("../src/chatgpt-web/intent-store.js");
  const { createDesktopJob, acquireDesktopJobLease, completeDesktopJob, loadDesktopJob } = await import("../src/desktop-agent/job-store.js");
  await appendReasoningTurn(root, { version: 1, turnId: "turn-analyze-read", sessionId: "session-analyze-old", runId, stage: "ANALYZE", generation: 1, promptSha256: "a".repeat(64), responseSha256: "b".repeat(64), summary: "Read repository context", decisions: [], desktopIntentIds: [intentId], outcome: "continue", recordedAt: at });
  await recordDesktopIntent(root, { intent, status: "accepted", recordedAt: at });
  const jobId = "web-recovery-feedback-job";
  await createDesktopJob(root, { version: 1, jobId, runId, stage: "ANALYZE", attempt: 0, agentId: "agent-1", workspaceRoot: production.worktreeRoot, policyDigest: policySha256, policySources: [], idempotencyKey: `web-intent:${runId}:${intentId}`, leaseUntil: "2026-09-14T11:10:00.000Z", operations: [{ id: intentId, type: "READ_FILE", path: "package.json" }] }, at);
  await acquireDesktopJobLease(root, jobId, "test-owner", at, 60_000);
  await completeDesktopJob(root, jobId, "test-owner", { version: 1, jobId, runId, agentId: "agent-1", status: "completed", completedAt: "2026-09-14T11:00:01.000Z", operations: [{ operationId: intentId, ok: true, summary: "Read package.json", stdout: "{\"scripts\":{\"test\":\"node --test\"}}" }] });
  await saveHarnessRun(root, { ...run, preflight: { version: 1, runId, status: "ready", policy: { version: 1, loadedAt: at, sources: [], effectiveSha256: policySha256 } }, state: { ...run.state, stage: "ANALYZE", status: "READY", completedStages: ["CONTEXT"] } });
  const browser = createFakeChatGptWebBrowserAdapter([
    { version: 1, runId, stage: "ANALYZE", generation: 1, summary: "Analysis complete", decisions: [], intents: [], outcome: "stage-complete" },
    { version: 1, runId, stage: "PLAN", generation: 1, summary: "Controlled stop", decisions: [], intents: [], outcome: "blocked-user", blockerReason: "stop after recovery verification" },
  ]);
  const driver = makeDriver(root, { proposal, browserAdapter: browser.adapter });
  await driver.advanceProduction(production);
  assert.equal(browser.submittedPrompts[0]?.kind, "feedback");
  assert.match(browser.submittedPrompts[0]!.body, /node --test/);
  assert.equal((await loadDesktopJob(root, jobId))?.attempts, 1);
});
function runnableAtDeploy(run: HarnessRuntimeRunEnvelope, sha: string): HarnessRuntimeRunEnvelope {
  return {
    ...run,
    preflight: {
      version: 1,
      runId: run.request.runId,
      status: "ready",
      policy: { version: 1, loadedAt: "now", sources: [], effectiveSha256: "policy" },
    },
    state: {
      ...run.state,
      stage: "DEPLOY",
      status: "READY",
      completedStages: ["CONTEXT", "ANALYZE", "PLAN", "IMPLEMENT", "TEST", "SELF_REVIEW", "COMMIT"],
    },
    evidence: [
      { version: 1, id: "test-red", kind: "test", stage: "TEST", recordedAt: "now", summary: "tested" },
      { version: 1, id: "review-red", kind: "review", stage: "SELF_REVIEW", recordedAt: "now", summary: "reviewed" },
      { version: 1, id: "commit-red", kind: "commit", stage: "COMMIT", recordedAt: "now", summary: "committed", reference: sha },
    ],
  };
}

function completedRun(run: HarnessRuntimeRunEnvelope, sha: string): HarnessRuntimeRunEnvelope {
  const atDeploy = runnableAtDeploy(run, sha);
  return {
    ...atDeploy,
    state: {
      ...atDeploy.state,
      stage: "DONE",
      status: "DONE",
      completedStages: [...atDeploy.state.completedStages, "DEPLOY", "PRODUCTION_VERIFY"],
    },
    evidence: [
      ...atDeploy.evidence,
      { version: 1, id: "deploy-done", kind: "deployment", stage: "DEPLOY", recordedAt: "now", summary: "deployed", reference: "https://preview" },
      { version: 1, id: "verify-done", kind: "production-verification", stage: "PRODUCTION_VERIFY", recordedAt: "now", summary: "verified", reference: "https://preview" },
    ],
  };
}

function baseProposal(campaignId: string): IdeaProposal {
  return { version: 1, id: `proposal-${campaignId}`, campaignId, title: "Focus", concept: "Focus", problemDomain: "study", targetUser: "students", jobToBeDone: "focus", coreInteractionLoop: "plan", dataModel: "sessions", primaryDifferentiator: "feedback", whyMateriallyDifferent: "loop", status: "accepted", createdAt: "2026-09-11T00:00:00.000Z" };
}

function makeDriver(root: string, options: any = {}) {
  const proposal = options.proposal ?? baseProposal("camp-1");
  const repositoryRoot = options.repositoryRoot ?? root;
  return createIdeaLabProductionRuntimeDriver({
    roots: { iseolRoot: root, modelRoot: root, runRoot: root, webRoot: root, browserProfileRoot: root },
    repositoryRoot, repositoryUrl: options.repositoryUrl ?? "https://github.com/acme/proto", baseRef: options.baseRef ?? "main", sandboxRoot: root,
    agentId: "agent-1", desktopStateRoot: options.desktopStateRoot ?? root, sandboxAdapter: options.sandbox ?? { inspect: async () => null, allocate: async (input: any) => ({ repositoryUrl: input.repositoryUrl, branch: `idea/${input.campaignId}/${input.productionId}`, worktreeRoot: input.run.request.targetRoot, baseRef: input.baseRef }) }, desktopTransport: options.desktopTransport ?? {} as never, browserAdapter: options.browserAdapter ?? {} as never,
    desktopTaskCompiler: async () => null, deployAdapter: options.deployAdapter ?? {} as never,
  });
}


test("Idea Lab Desktop compiler emits a job id accepted by the durable job store", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-jobid-"));
  const { createIdeaLabProductionDesktopTaskCompiler } = await import("../src/idea-lab/production-desktop-compiler.js");
  const { createDesktopJob } = await import("../src/desktop-agent/job-store.js");
  const at = "2026-09-14T06:00:00.000Z";
  const runId = "run-camp-job-prod-1";
  const run: HarnessRuntimeRunEnvelope = {
    version: 1,
    request: { version: 1, runId, mode: "idea-lab", objective: "prototype", targetRoot: root },
    preflight: { version: 1, runId, status: "ready", policy: { version: 1, loadedAt: at, sources: [{ kind: "iseol-global", path: join(root, "HARNESS_ENGINEERING.md"), sha256: "a".repeat(64), content: "policy" }], effectiveSha256: "b".repeat(64) } },
    state: { version: 1, stage: "CONTEXT", status: "READY", completedStages: ["PREFLIGHT"], skippedStages: [], updatedAt: at },
    evidence: [], updatedAt: at,
  };
  const compiler = createIdeaLabProductionDesktopTaskCompiler({
    enabled: true, repositoryRoot: root, repositoryUrl: "https://github.com/acme/proto", baseRef: "main",
    sandboxRoot: root, agentId: "agent-1", testExecutable: "npm.cmd", testArgs: ["test"], testTimeoutMs: 120000,
  }, { now: () => at });
  const pack = await compiler(run, "agent-1");
  assert.ok(pack);
  await assert.doesNotReject(() => createDesktopJob(root, pack, at));
});

test("Idea Lab Web reasoning consumes an executed RED test failure as Desktop feedback", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-red-feedback-"));
  const proposal = baseProposal("camp-red-feedback");
  const bootstrap = makeDriver(root, { proposal });
  const production = await bootstrap.createProduction(proposal, 1);
  await saveIdeaProposal(root, proposal);
  const { loadHarnessRun } = await import("../src/harness/run-store.js");
  const { registerDesktopAgent } = await import("../src/desktop-agent/agent-registry.js");
  const run = await loadHarnessRun(root, production.runId);
  assert.ok(run);
  const { createHash } = await import("node:crypto");
  const { writeFile } = await import("node:fs/promises");
  const policyPath = join(root, "HARNESS_ENGINEERING.md");
  const policyContent = "policy\n";
  await writeFile(policyPath, policyContent, "utf8");
  const policySourceSha256 = createHash("sha256").update(policyContent, "utf8").digest("hex");
  const policySha256 = createHash("sha256").update(`iseol-global\n${policyPath}\n${policySourceSha256}`, "utf8").digest("hex");
  await saveHarnessRun(root, { ...run, preflight: { version: 1, runId: production.runId, status: "ready", policy: { version: 1, loadedAt: new Date().toISOString(), sources: [{ kind: "iseol-global", path: policyPath, sha256: policySourceSha256, content: policyContent }], effectiveSha256: policySha256 } }, state: { ...run.state, stage: "IMPLEMENT", status: "READY", completedStages: ["CONTEXT", "ANALYZE", "PLAN"] } });
  await registerDesktopAgent(root, { version: 1, agentId: "agent-1", agentVersion: "test", os: "win32", capabilities: ["process"], workspaceRoots: [production.worktreeRoot], token: "not-persisted" }, new Date().toISOString());
  const intentId = "implement-run-red-test";
  const browser = createFakeChatGptWebBrowserAdapter([
    { version: 1, runId: production.runId, stage: "IMPLEMENT", generation: 1, summary: "Run RED", decisions: [], outcome: "continue", intents: [{ version: 1, intentId, runId: production.runId, stage: "IMPLEMENT", workspaceRoot: production.worktreeRoot, policySha256, kind: "RUN_TEST", cwd: ".", executable: "npm", args: ["test"], timeoutMs: 120000 }] },
    { version: 1, runId: production.runId, stage: "IMPLEMENT", generation: 1, summary: "Stop after RED feedback", decisions: [], intents: [], outcome: "blocked-user", blockerReason: "verified RED feedback" },
  ]);
  const transport = { isAgentConnected: () => true, getAgentSessionId: () => "session-red", sendTask: () => undefined, awaitResult: async (jobId: string) => ({ version: 1, jobId, runId: production.runId, agentId: "agent-1", status: "retryable-failure" as const, completedAt: new Date().toISOString(), operations: [{ operationId: intentId, ok: false, summary: "Ran npm exited with code 1", stdout: "RED test failed" }] }) };
  const driver = makeDriver(root, { proposal, browserAdapter: browser.adapter, desktopTransport: transport });
  await driver.advanceProduction(production);
  assert.equal(browser.submittedPrompts.length, 2);
  assert.equal(browser.submittedPrompts[1]?.kind, "feedback");
  assert.match(browser.submittedPrompts[1]?.body ?? "", /RED test failed/);
});
