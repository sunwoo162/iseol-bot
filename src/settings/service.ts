import { assertIdentityId, assertTimestamp, type Principal } from "../identity/contracts.js";
import type { SettingsService, UserSettings, UserSettingsPatch } from "./contracts.js";
import { loadSettings, saveSettings } from "./store.js";

const defaults: Omit<UserSettings, "version" | "userId" | "createdAt" | "updatedAt"> = {
  aiAccess: { memory: true, projectFiles: true, learningHistory: true, activityTimeline: true, teamDocs: false },
  aiApproval: { fileWrite: true, packageInstall: true, buildRun: false, externalApi: true },
  notifications: { aiDone: true, teamInvite: true, newMessage: true, achieve: true, weekly: false },
  privacy: { growthInfo: true, projectList: true, learningHistory: false },
};

function ensurePrincipal(principal: Principal): void { assertIdentityId(principal.userId); }
function booleanPatch<T extends Record<string, boolean>>(current: T, patch: Partial<T> | undefined, label: string): T {
  if (!patch) return { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in current) || typeof value !== "boolean") throw new Error(`Invalid ${label} setting`);
  }
  return { ...current, ...patch };
}

export function createSettingsService(root: string, options: { now?: () => string } = {}): SettingsService {
  const now = options.now ?? (() => new Date().toISOString());
  const updateTails = new Map<string, Promise<void>>();
  async function withUserUpdateLock<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const prior = updateTails.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = prior.then(() => current);
    updateTails.set(userId, queued);
    await prior;
    try { return await task(); }
    finally {
      release();
      if (updateTails.get(userId) === queued) updateTails.delete(userId);
    }
  }
  return {
    async getSettings(principal) {
      ensurePrincipal(principal);
      const existing = await loadSettings(root, principal.userId);
      if (existing && existing.userId === principal.userId) {
        const normalized: UserSettings = { ...existing, aiAccess: { ...defaults.aiAccess, ...existing.aiAccess } };
        if (normalized.aiAccess.memory !== existing.aiAccess.memory) await saveSettings(root, normalized);
        return normalized;
      }
      const at = now();
      assertTimestamp(at, "settings timestamp");
      const created: UserSettings = { version: 1, userId: principal.userId, ...defaults, createdAt: at, updatedAt: at };
      await saveSettings(root, created);
      return created;
    },
    async updateSettings(principal, patch: UserSettingsPatch) {
      ensurePrincipal(principal);
      return withUserUpdateLock(principal.userId, async () => {
        const current = await this.getSettings(principal);
        if (!patch || typeof patch !== "object") throw new Error("Settings patch is required");
        const at = now();
        assertTimestamp(at, "settings timestamp");
        const next: UserSettings = {
          ...current,
          aiAccess: booleanPatch(current.aiAccess, patch.aiAccess, "AI access"),
          aiApproval: booleanPatch(current.aiApproval, patch.aiApproval, "AI approval"),
          notifications: booleanPatch(current.notifications, patch.notifications, "notification"),
          privacy: booleanPatch(current.privacy, patch.privacy, "privacy"),
          updatedAt: at,
        };
        await saveSettings(root, next);
        return next;
      });
    },
  };
}
