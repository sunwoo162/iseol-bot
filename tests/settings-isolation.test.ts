import assert from "node:assert/strict";
import { mkdtemp, rename as fsRename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createSettingsService } from "../src/settings/service.js";
import { loadSettings, saveSettings } from "../src/settings/store.js";

const at = "2026-09-26T12:00:00.000Z";
const principal = (userId: string): Principal => ({ userId, sessionId: `${userId}-session`, roles: ["user"] });

test("settings durable writes retry transient Windows renames", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-settings-rename-"));
  const settings = {
    version: 1 as const,
    userId: "settings-rename-user",
    aiAccess: { memory: true, projectFiles: true, learningHistory: true, activityTimeline: true, teamDocs: false },
    aiApproval: { fileWrite: true, packageInstall: true, buildRun: false, externalApi: true },
    notifications: { aiDone: true, teamInvite: true, newMessage: true, achieve: true, weekly: false },
    privacy: { growthInfo: true, projectList: true, learningHistory: false },
    createdAt: at,
    updatedAt: at,
  };
  let attempts = 0;
  await saveSettings(root, settings, {
    rename: async (source, target) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("locked"), { code: "EPERM" });
      await fsRename(source, target);
    },
    sleep: async () => undefined,
  });
  assert.equal(attempts, 2);
  assert.deepEqual(await loadSettings(root, settings.userId), settings);
});

test("settings persist per user and reject invalid cross-group values", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-settings-"));
  const settings = createSettingsService(root, { now: () => at });
  const a = principal("settings-a"); const b = principal("settings-b");
  const initial = await settings.getSettings(a);
  assert.equal(initial.aiAccess.projectFiles, true);
  assert.equal(initial.aiAccess.memory, true);
  const updated = await settings.updateSettings(a, { aiAccess: { projectFiles: false }, privacy: { projectList: false } });
  assert.equal(updated.aiAccess.projectFiles, false);
  assert.equal((await settings.getSettings(a)).privacy.projectList, false);
  assert.equal((await settings.getSettings(b)).aiAccess.projectFiles, true);
  const memoryDisabled = await settings.updateSettings(a, { aiAccess: { memory: false } });
  assert.equal(memoryDisabled.aiAccess.memory, false);
  assert.equal((await settings.getSettings(a)).aiAccess.memory, false);
  assert.equal((await settings.getSettings(b)).aiAccess.memory, true);
  await assert.rejects(() => settings.updateSettings(a, { aiAccess: { projectFiles: "false" as unknown as boolean } }), /Invalid AI access setting|boolean/i);
});

test("concurrent settings patches for one user preserve every independent change", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-settings-concurrent-"));
  const settings = createSettingsService(root, { now: () => at });
  const owner = principal("settings-concurrent-owner");
  await settings.getSettings(owner);

  await Promise.all([
    settings.updateSettings(owner, { aiAccess: { memory: false } }),
    settings.updateSettings(owner, { aiAccess: { projectFiles: false } }),
    settings.updateSettings(owner, { aiAccess: { activityTimeline: false } }),
    settings.updateSettings(owner, { aiAccess: { teamDocs: true } }),
  ]);

  const persisted = await settings.getSettings(owner);
  assert.deepEqual(persisted.aiAccess, {
    memory: false,
    projectFiles: false,
    learningHistory: true,
    activityTimeline: false,
    teamDocs: true,
  });
});
