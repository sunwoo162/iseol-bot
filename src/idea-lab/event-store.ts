import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IdeaLabCampaignEvent } from "./contracts.js";
import { assertIdeaLabCampaignEvent, assertIdeaLabId } from "./contracts.js";
import { ideaLabDirectory } from "./store-utils.js";

function eventFile(root: string, campaignId: string): string {
  assertIdeaLabId(campaignId);
  return resolve(ideaLabDirectory(root, "campaign-events"), `${campaignId}.jsonl`);
}

export async function listIdeaLabCampaignEvents(root: string, campaignId: string): Promise<IdeaLabCampaignEvent[]> {
  const path = eventFile(root, campaignId);
  try {
    const content = await readFile(path, "utf8");
    return content.split(/\r?\n/).filter(Boolean).map((line) => {
      const event = JSON.parse(line) as IdeaLabCampaignEvent;
      assertIdeaLabCampaignEvent(event);
      return event;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function appendIdeaLabCampaignEventOnce(root: string, event: IdeaLabCampaignEvent): Promise<boolean> {
  assertIdeaLabCampaignEvent(event);
  const existing = (await listIdeaLabCampaignEvents(root, event.campaignId)).find((item) => item.id === event.id);
  if (existing) {
    const same = existing.campaignId === event.campaignId
      && existing.type === event.type
      && existing.proposalId === event.proposalId
      && existing.productionId === event.productionId
      && existing.runId === event.runId
      && existing.reference === event.reference;
    if (!same) throw new Error(`Idea Lab campaign event identity mismatch: ${event.id}`);
    return false;
  }
  const path = eventFile(root, event.campaignId);
  await mkdir(resolve(path, ".."), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
  return true;
}
