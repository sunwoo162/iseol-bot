import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IdeaProposal, PrototypeProduction } from "../src/idea-lab/contracts.js";
import { saveIdeaLabCampaign, loadIdeaLabCampaign } from "../src/idea-lab/campaign-store.js";
import { listPrototypeProductions } from "../src/idea-lab/production-store.js";
import { FakeIdeaProposalProvider } from "../src/idea-lab/test-support/fake-proposal-provider.js";
import {
  IdeaLabCampaignBlockedError,
  superviseIdeaLabCampaign,
} from "../src/idea-lab/campaign-supervisor.js";

const NOW = "2026-09-08T05:00:00.000Z";
const draft = (title: string, n: number) => ({
  title, concept: `${title} concept`, problemDomain: `domain-${n}`, targetUser: `user-${n}`,
  jobToBeDone: `job-${n}`, coreInteractionLoop: `loop-${n}`, dataModel: `model-${n}`,
  primaryDifferentiator: `diff-${n}`, whyMateriallyDifferent: `reason-${n}`,
});

async function fixture(targetReadyCount = 3) {
  const root = await mkdtemp(join(tmpdir(), "iseol-campaign-supervisor-"));
  await saveIdeaLabCampaign(root, {
    version: 1, id: "camp-1", seed: "student tools", constraints: [], targetReadyCount,
    productionConcurrency: 1, proposalIds: [], productionIds: [], status: "generating",
    createdAt: NOW, updatedAt: NOW,
  });
  return root;
}

function productionFor(proposal: IdeaProposal, ordinal: number): PrototypeProduction {
  const id = `camp-1-prod-${ordinal}`;
  return {
    version: 1, id, campaignId: proposal.campaignId, proposalId: proposal.id, runId: `run-${id}`,
    repositoryUrl: "https://example.invalid/sandbox.git", sandboxRoot: "C:/sandbox",
    worktreeRoot: `C:/sandbox/worktrees/${id}`, branch: `idea/camp-1/${id}`, baseRef: "main",
    status: "queued", createdAt: NOW, updatedAt: NOW,
  };
}

test("campaign reaches target READY count with concurrency one and canonical productions", async () => {
  const root = await fixture();
  const provider = new FakeIdeaProposalProvider([[draft("A", 1)], [draft("B", 2)], [draft("C", 3)]]);
  const result = await superviseIdeaLabCampaign({
    root, campaignId: "camp-1", proposalProvider: provider,
    createProduction: async (proposal, ordinal) => productionFor(proposal, ordinal),
    advanceProduction: async (production) => ({ ...production, status: "ready", commitSha: `${production.id}-sha`, updatedAt: NOW }),
    now: () => NOW, maxSteps: 32,
  });
  assert.equal(result.status, "complete");
  const productions = (await listPrototypeProductions(root)).filter((item) => item.campaignId === "camp-1");
  assert.equal(productions.length, 3);
  assert.equal(productions.every((item) => item.status === "ready"), true);
  assert.equal(new Set(productions.map((item) => item.proposalId)).size, 3);
});

test("failed production is replenished without recreating successful canonical Runs", async () => {
  const root = await fixture();
  const provider = new FakeIdeaProposalProvider([[draft("A", 1)], [draft("B", 2)], [draft("C", 3)], [draft("D", 4)]]);
  const attempts = new Map<string, number>();
  const result = await superviseIdeaLabCampaign({
    root, campaignId: "camp-1", proposalProvider: provider,
    createProduction: async (proposal, ordinal) => productionFor(proposal, ordinal),
    advanceProduction: async (production) => {
      attempts.set(production.id, (attempts.get(production.id) ?? 0) + 1);
      if (production.proposalId.endsWith("2")) return { ...production, status: "failed", failureSummary: "build failed", updatedAt: NOW };
      return { ...production, status: "ready", commitSha: `${production.id}-sha`, updatedAt: NOW };
    },
    now: () => NOW, maxSteps: 48,
  });
  assert.equal(result.status, "complete");
  const productions = (await listPrototypeProductions(root)).filter((item) => item.campaignId === "camp-1");
  assert.equal(productions.length, 4);
  assert.equal(productions.filter((item) => item.status === "ready").length, 3);
  assert.equal(attempts.get("camp-1-prod-1"), 1);
  assert.equal(attempts.get("camp-1-prod-3"), 1);
});

test("restart resumes stored productions and does not duplicate proposal or production identity", async () => {
  const root = await fixture(1);
  const provider = new FakeIdeaProposalProvider([[draft("A", 1)]]);
  const input = {
    root, campaignId: "camp-1", proposalProvider: provider,
    createProduction: async (proposal: IdeaProposal, ordinal: number) => productionFor(proposal, ordinal),
    advanceProduction: async (production: PrototypeProduction) => ({ ...production, status: "ready" as const, commitSha: `${production.id}-sha`, updatedAt: NOW }),
    now: () => NOW, maxSteps: 1,
  };
  await superviseIdeaLabCampaign(input);
  const before = await loadIdeaLabCampaign(root, "camp-1");
  const result = await superviseIdeaLabCampaign({ ...input, maxSteps: 16 });
  assert.equal(result.status, "complete");
  assert.equal(result.proposalIds.length, 1);
  assert.equal(result.productionIds.length, 1);
  assert.equal(before?.proposalIds[0], result.proposalIds[0]);
});

test("missing provider or protected production blocker moves Campaign to blocked with safe summary", async () => {
  const root = await fixture(1);
  const missing = await superviseIdeaLabCampaign({
    root, campaignId: "camp-1",
    createProduction: async (proposal, ordinal) => productionFor(proposal, ordinal),
    advanceProduction: async (production) => production,
    now: () => NOW,
  });
  assert.equal(missing.status, "blocked");
  assert.match(missing.blockerSummary ?? "", /proposal provider/i);

  await saveIdeaLabCampaign(root, { ...missing, status: "generating", blockerSummary: undefined, updatedAt: NOW });
  const provider = new FakeIdeaProposalProvider([[draft("A", 1)]]);
  const blocked = await superviseIdeaLabCampaign({
    root, campaignId: "camp-1", proposalProvider: provider,
    createProduction: async () => { throw new IdeaLabCampaignBlockedError("Desktop Agent unavailable"); },
    advanceProduction: async (production) => production,
    now: () => NOW, maxSteps: 8,
  });
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.blockerSummary ?? "", /Desktop Agent unavailable/);
  assert.doesNotMatch(blocked.blockerSummary ?? "", /token|cookie|secret=/i);
});
