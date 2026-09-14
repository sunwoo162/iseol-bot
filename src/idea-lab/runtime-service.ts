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
  const freshQueue: string[] = [];
  const recoveryQueue: string[] = [];
  const scheduled = new Set<string>();
  let accepting = true;
  let running = false;
  let drainWaiters: Array<() => void> = [];

  const signalIdle = () => {
    if (!running && freshQueue.length === 0 && recoveryQueue.length === 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (freshQueue.length || recoveryQueue.length) {
        const campaignId = freshQueue.shift() ?? recoveryQueue.shift()!;
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

  const schedule = (campaignId: string, source: "fresh" | "recovery"): void => {
    if (!accepting || scheduled.has(campaignId)) return;
    scheduled.add(campaignId);
    (source === "fresh" ? freshQueue : recoveryQueue).push(campaignId);
    void pump();
  };
  const enqueue = (campaignId: string): void => schedule(campaignId, "fresh");

  return {
    enqueue,
    async recover() {
      for (const campaign of await listIdeaLabCampaigns(options.modelRoot)) {
        if (campaign.status === "generating" || campaign.status === "producing") schedule(campaign.id, "recovery");
      }
    },
    idle() {
      if (!running && freshQueue.length === 0 && recoveryQueue.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => drainWaiters.push(resolve));
    },
    async dispose() {
      accepting = false;
      await this.idle();
    },
  };
}
