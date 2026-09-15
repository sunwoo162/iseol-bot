import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIdeaLabProductionRuntimeDriver } from "../src/idea-lab/production-runtime-driver.js";
import type { IdeaProposal } from "../src/idea-lab/contracts.js";
import { saveIdeaProposal } from "../src/idea-lab/proposal-store.js";
import { loadHarnessRun, saveHarnessRun } from "../src/harness/run-store.js";
import { loadPrototypeProduction } from "../src/idea-lab/production-store.js";
import { createFakeChatGptWebBrowserAdapter } from "../src/chatgpt-web/test-support/fake-browser-adapter.js";
import { ChatGptWebStructuredResultError } from "../src/chatgpt-web/browser-adapter.js";

function proposal(): IdeaProposal {
  return {
    version: 1,
    id: "proposal-budget-retry",
    campaignId: "camp-budget-retry",
    title: "Budget retry",
    concept: "Recover from transient structured output failures",
    problemDomain: "development",
    targetUser: "developer",
    jobToBeDone: "retry reasoning",
    coreInteractionLoop: "reason-retry",
    dataModel: "turns",
    primaryDifferentiator: "retry",
    whyMateriallyDifferent: "does not permanently fail on transient protocol noise",
    status: "accepted",
    createdAt: "2026-09-16T00:00:00.000Z",
  };
}

function makeDriver(root: string, browserAdapter: any) {
  return createIdeaLabProductionRuntimeDriver({
    roots: { iseolRoot: root, modelRoot: root, runRoot: root, webRoot: root, browserProfileRoot: root },
    repositoryRoot: root,
    repositoryUrl: "https://github.com/acme/proto",
    baseRef: "main",
    sandboxRoot: root,
    agentId: "agent-1",
    sandboxAdapter: {
      inspect: async () => null,
      allocate: async (input: any) => ({
        repositoryUrl: input.repositoryUrl,
        branch: `idea/${input.campaignId}/${input.productionId}`,
        worktreeRoot: input.run.request.targetRoot,
        baseRef: input.baseRef,
      }),
    },
    desktopTransport: {} as never,
    browserAdapter,
    desktopStateRoot: root,
    desktopTaskCompiler: async () => null,
    deployAdapter: {} as never,
  });
}

test("Idea Lab retries after structured-result rejection budget instead of permanently failing", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-driver-structured-retry-"));
  const proposalValue = proposal();
  const bootstrap = makeDriver(root, {} as never);
  const production = await bootstrap.createProduction(proposalValue, 1);
  await saveIdeaProposal(root, proposalValue);

  const run = await loadHarnessRun(root, production.runId);
  assert.ok(run);
  await saveHarnessRun(root, {
    ...run,
    preflight: {
      version: 1,
      runId: production.runId,
      status: "ready",
      policy: {
        version: 1,
        loadedAt: "2026-09-16T00:00:00.000Z",
        sources: [],
        effectiveSha256: "policy",
      },
    },
    state: {
      ...run.state,
      stage: "IMPLEMENT",
      status: "READY",
      completedStages: ["PREFLIGHT", "CONTEXT", "ANALYZE", "PLAN"],
    },
  });

  const error = () => new ChatGptWebStructuredResultError("ChatGPT structured result is not exactly one JSON value");
  const fake = createFakeChatGptWebBrowserAdapter([
    error(),
    error(),
    error(),
    {
      version: 1,
      runId: production.runId,
      stage: "IMPLEMENT",
      generation: 1,
      summary: "Controlled stop after protocol recovery",
      decisions: [],
      intents: [],
      outcome: "blocked-user",
      blockerReason: "verified structured-result retry",
    },
  ]);

  const driver = makeDriver(root, fake.adapter);
  const result = await driver.advanceProduction(production);
  const finalRun = await loadHarnessRun(root, production.runId);

  assert.equal(result.status, "running");
  assert.equal(finalRun?.state.status, "BLOCKED_USER");
  assert.equal(finalRun?.state.reason, "verified structured-result retry");
  assert.equal(fake.submittedPrompts.length, 4);
  assert.equal((await loadPrototypeProduction(root, production.id))?.status, "running");
});
