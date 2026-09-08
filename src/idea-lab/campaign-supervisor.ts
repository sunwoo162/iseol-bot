import type { IdeaLabCampaign, IdeaProposal, PrototypeProduction } from "./contracts.js";
import { loadIdeaLabCampaign, saveIdeaLabCampaign } from "./campaign-store.js";
import { loadIdeaProposal, saveIdeaProposal } from "./proposal-store.js";
import { listPrototypeProductions, savePrototypeProduction } from "./production-store.js";
import { appendIdeaLabCampaignEventOnce } from "./event-store.js";
import type { IdeaProposalDraft, IdeaProposalProvider } from "./proposal-provider.js";
import { assertIdeaProposalProviderResult } from "./proposal-provider.js";
import { evaluateProposalDistinctness } from "./distinctness.js";

export class IdeaLabCampaignBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdeaLabCampaignBlockedError";
  }
}

export type SuperviseIdeaLabCampaignInput = {
  root: string;
  campaignId: string;
  proposalProvider?: IdeaProposalProvider;
  createProduction(proposal: IdeaProposal, ordinal: number): Promise<PrototypeProduction>;
  advanceProduction(production: PrototypeProduction): Promise<PrototypeProduction>;
  maxSteps?: number;
  proposalAttemptBudget?: number;
  now?: () => string;
};

const ACTIVE_PRODUCTION_STATUSES = new Set<PrototypeProduction["status"]>([
  "queued", "running", "testing", "deploying", "verifying",
]);

function safeSummary(value: string): string {
  return value
    .replace(/\b(token|cookie|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240);
}

function proposalDraft(proposal: IdeaProposal): IdeaProposalDraft {
  return {
    title: proposal.title,
    concept: proposal.concept,
    problemDomain: proposal.problemDomain,
    targetUser: proposal.targetUser,
    jobToBeDone: proposal.jobToBeDone,
    coreInteractionLoop: proposal.coreInteractionLoop,
    dataModel: proposal.dataModel,
    primaryDifferentiator: proposal.primaryDifferentiator,
    whyMateriallyDifferent: proposal.whyMateriallyDifferent,
  };
}

async function loadCampaignProposals(root: string, campaign: IdeaLabCampaign): Promise<IdeaProposal[]> {
  const items: IdeaProposal[] = [];
  for (const id of campaign.proposalIds) {
    const proposal = await loadIdeaProposal(root, id);
    if (!proposal) throw new Error(`Idea Lab proposal missing from Campaign: ${id}`);
    items.push(proposal);
  }
  return items;
}

function assertProductionIdentity(production: PrototypeProduction, campaign: IdeaLabCampaign, proposal: IdeaProposal): void {
  if (production.campaignId !== campaign.id || production.proposalId !== proposal.id) {
    throw new Error("Idea Lab production identity mismatch");
  }
  if (!production.runId.trim()) throw new Error("Idea Lab production requires one canonical Run id");
}

async function blockCampaign(
  input: SuperviseIdeaLabCampaignInput,
  campaign: IdeaLabCampaign,
  reason: string,
): Promise<IdeaLabCampaign> {
  const at = (input.now ?? (() => new Date().toISOString()))();
  const blockerSummary = safeSummary(reason);
  await appendIdeaLabCampaignEventOnce(input.root, {
    version: 1,
    id: `${campaign.id}-blocked`,
    campaignId: campaign.id,
    type: "campaign-blocked",
    at,
    summary: blockerSummary,
  });
  const next = { ...campaign, status: "blocked" as const, blockerSummary, updatedAt: at };
  await saveIdeaLabCampaign(input.root, next);
  return next;
}

async function completeCampaign(
  input: SuperviseIdeaLabCampaignInput,
  campaign: IdeaLabCampaign,
): Promise<IdeaLabCampaign> {
  const at = (input.now ?? (() => new Date().toISOString()))();
  await appendIdeaLabCampaignEventOnce(input.root, {
    version: 1,
    id: `${campaign.id}-completed`,
    campaignId: campaign.id,
    type: "campaign-completed",
    at,
    summary: `Campaign reached ${campaign.targetReadyCount} READY prototypes`,
  });
  const next = { ...campaign, status: "complete" as const, blockerSummary: undefined, updatedAt: at };
  await saveIdeaLabCampaign(input.root, next);
  return next;
}

async function generateOneProposal(
  input: SuperviseIdeaLabCampaignInput,
  campaign: IdeaLabCampaign,
  proposals: IdeaProposal[],
  attemptBudget: number,
): Promise<IdeaLabCampaign> {
  if (!input.proposalProvider) return blockCampaign(input, campaign, "Idea proposal provider is not configured");
  const attempt = campaign.proposalIds.length + 1;
  if (attempt > attemptBudget) return blockCampaign(input, campaign, "Idea proposal attempt budget exhausted");
  const acceptedDrafts = proposals.filter((item) => item.status === "accepted").map(proposalDraft);
  const generated = await input.proposalProvider.generate({
    seed: campaign.seed,
    constraints: [...campaign.constraints],
    requestedCount: 1,
    accepted: acceptedDrafts,
    attempt,
  });
  assertIdeaProposalProviderResult(generated, 1);
  const item = generated[0]!;
  const distinctness = evaluateProposalDistinctness(item, acceptedDrafts);
  const id = `${campaign.id}-proposal-${attempt}`;
  const at = (input.now ?? (() => new Date().toISOString()))();
  const proposal: IdeaProposal = {
    version: 1,
    id,
    campaignId: campaign.id,
    ...item,
    status: distinctness.distinct ? "accepted" : "rejected",
    createdAt: at,
  };
  await saveIdeaProposal(input.root, proposal);
  await appendIdeaLabCampaignEventOnce(input.root, {
    version: 1,
    id: `${id}-${proposal.status}`,
    campaignId: campaign.id,
    type: proposal.status === "accepted" ? "proposal-generated" : "proposal-rejected",
    at,
    summary: proposal.status === "accepted" ? `Accepted proposal ${id}` : safeSummary(distinctness.reason ?? `Rejected proposal ${id}`),
    proposalId: id,
  });
  const next = {
    ...campaign,
    proposalIds: [...campaign.proposalIds, id],
    status: proposal.status === "accepted" ? "producing" as const : campaign.status,
    updatedAt: at,
  };
  await saveIdeaLabCampaign(input.root, next);
  return next;
}

async function createNextProduction(
  input: SuperviseIdeaLabCampaignInput,
  campaign: IdeaLabCampaign,
  proposals: IdeaProposal[],
  productions: PrototypeProduction[],
): Promise<IdeaLabCampaign | null> {
  const producedProposalIds = new Set(productions.map((item) => item.proposalId));
  const proposal = proposals.find((item) => item.status === "accepted" && !producedProposalIds.has(item.id));
  if (!proposal) return null;
  try {
    const production = await input.createProduction(proposal, productions.length + 1);
    assertProductionIdentity(production, campaign, proposal);
    if (productions.some((item) => item.id === production.id && item.proposalId !== proposal.id)) {
      throw new Error(`Idea Lab production id conflict: ${production.id}`);
    }
    const at = (input.now ?? (() => new Date().toISOString()))();
    await savePrototypeProduction(input.root, production);
    await appendIdeaLabCampaignEventOnce(input.root, {
      version: 1,
      id: `${production.id}-created`,
      campaignId: campaign.id,
      type: "production-created",
      at,
      summary: `Created production ${production.id}`,
      proposalId: proposal.id,
      productionId: production.id,
      runId: production.runId,
    });
    const next = {
      ...campaign,
      productionIds: campaign.productionIds.includes(production.id)
        ? campaign.productionIds
        : [...campaign.productionIds, production.id],
      status: "producing" as const,
      updatedAt: at,
    };
    await saveIdeaLabCampaign(input.root, next);
    return next;
  } catch (error) {
    if (error instanceof IdeaLabCampaignBlockedError) {
      return blockCampaign(input, campaign, error.message);
    }
    throw error;
  }
}

async function advanceOneProduction(
  input: SuperviseIdeaLabCampaignInput,
  campaign: IdeaLabCampaign,
  production: PrototypeProduction,
): Promise<IdeaLabCampaign | null> {
  try {
    const nextProduction = await input.advanceProduction(production);
    if (nextProduction.id !== production.id
      || nextProduction.campaignId !== production.campaignId
      || nextProduction.proposalId !== production.proposalId
      || nextProduction.runId !== production.runId) {
      throw new Error(`Idea Lab production advance identity mismatch: ${production.id}`);
    }
    const at = (input.now ?? (() => new Date().toISOString()))();
    await savePrototypeProduction(input.root, nextProduction);
    await appendIdeaLabCampaignEventOnce(input.root, {
      version: 1,
      id: `${production.id}-status-${nextProduction.status}`,
      campaignId: campaign.id,
      type: nextProduction.status === "ready" ? "prototype-ready" : "production-status-changed",
      at,
      summary: `Production ${production.id} is ${nextProduction.status}`,
      proposalId: production.proposalId,
      productionId: production.id,
      runId: production.runId,
    });
    if (nextProduction.status === "blocked") {
      return blockCampaign(input, campaign, nextProduction.blockerSummary ?? `Production ${production.id} is blocked`);
    }
    return null;
  } catch (error) {
    if (error instanceof IdeaLabCampaignBlockedError) {
      return blockCampaign(input, campaign, error.message);
    }
    throw error;
  }
}

export async function superviseIdeaLabCampaign(
  input: SuperviseIdeaLabCampaignInput,
): Promise<IdeaLabCampaign> {
  const maxSteps = input.maxSteps ?? 64;
  const proposalAttemptBudget = input.proposalAttemptBudget ?? 24;
  if (!Number.isInteger(maxSteps) || maxSteps <= 0) throw new Error("Idea Lab maxSteps must be positive");
  if (!Number.isInteger(proposalAttemptBudget) || proposalAttemptBudget <= 0) {
    throw new Error("Idea Lab proposalAttemptBudget must be positive");
  }
  let campaign = await loadIdeaLabCampaign(input.root, input.campaignId);
  if (!campaign) throw new Error(`Idea Lab Campaign not found: ${input.campaignId}`);
  if (campaign.status === "complete" || campaign.status === "cancelled") return campaign;
  if (campaign.status === "blocked") return campaign;

  let steps = 0;
  while (steps < maxSteps) {
    const productions = (await listPrototypeProductions(input.root))
      .filter((item) => item.campaignId === campaign!.id);
    const readyCount = productions.filter((item) => item.status === "ready").length;
    if (readyCount >= campaign.targetReadyCount) return completeCampaign(input, campaign);

    const blocked = productions.find((item) => item.status === "blocked");
    if (blocked) return blockCampaign(input, campaign, blocked.blockerSummary ?? `Production ${blocked.id} is blocked`);

    const active = productions.filter((item) => ACTIVE_PRODUCTION_STATUSES.has(item.status));
    if (active.length > 0) {
      const blockedCampaign = await advanceOneProduction(input, campaign, active[0]!);
      steps += 1;
      if (blockedCampaign) return blockedCampaign;
      campaign = (await loadIdeaLabCampaign(input.root, campaign.id))!;
      continue;
    }

    const proposals = await loadCampaignProposals(input.root, campaign);
    const created = await createNextProduction(input, campaign, proposals, productions);
    if (created) {
      steps += 1;
      if (created.status === "blocked") return created;
      campaign = created;
      continue;
    }

    campaign = await generateOneProposal(input, campaign, proposals, proposalAttemptBudget);
    steps += 1;
    if (campaign.status === "blocked") return campaign;
  }
  return campaign;
}
