import { listIdeaLabCampaigns } from "./campaign-store.js";

export type IdeaLabRuntimeService = {
  enqueue(campaignId: string): void;
  recover(): Promise<void>;
  idle(): Promise<void>;
  dispose(): Promise<void>;
};

export type IdeaLabRuntimeOptions = {
  modelRoot: string;
  superviseCampaign: (campaignId: string) => Promise<void>;
  onError?: (campaignId: string, safeSummary: string) => void;
  concurrency?: 1;
};

const SAFE_ERROR_SUMMARY = "Campaign supervision failed";

export function createIdeaLabRuntimeService(options: IdeaLabRuntimeOptions): IdeaLabRuntimeService {
  const concurrency = options.concurrency as number | undefined;
  if (concurrency !== undefined && concurrency !== 1) {
    throw new Error("Idea Lab runtime concurrency must be 1");
  }
  const queue: string[] = [];
  const scheduled = new Set<string>();
  let accepting = true;
  let running = false;
  let drainWaiters: Array<() => void> = [];

  const signalIdle = () => {
    if (!running && queue.length === 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        const campaignId = queue.shift()!;
        try {
          await options.superviseCampaign(campaignId);
        } catch {
          try { options.onError?.(campaignId, SAFE_ERROR_SUMMARY); } catch { /* reporting must not stop the worker */ }
        } finally {
          scheduled.delete(campaignId);
        }
      }
    } finally {
      running = false;
      signalIdle();
    }
  };

  const enqueue = (campaignId: string): void => {
    if (!accepting || scheduled.has(campaignId)) return;
    scheduled.add(campaignId);
    queue.push(campaignId);
    void pump();
  };

  return {
    enqueue,
    async recover() {
      for (const campaign of await listIdeaLabCampaigns(options.modelRoot)) {
        if (campaign.status === "generating" || campaign.status === "producing") enqueue(campaign.id);
      }
    },
    idle() {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.push(resolve));
    },
    async dispose() {
      accepting = false;
      await this.idle();
    },
  };
}
