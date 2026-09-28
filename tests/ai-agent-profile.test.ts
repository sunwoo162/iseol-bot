import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createAiAgentProfileService } from "../src/ai-agent/service.js";

const principal = (userId: string): Principal => ({ userId, sessionId: `${userId}-session`, roles: ["user"] });

test("missing agent profile resolves to the stable default 이설 profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "npc-agent-profile-"));
  const service = createAiAgentProfileService(root, { now: () => "2026-09-27T12:00:00.000Z" });

  const profile = await service.getProfile(principal("profile-default"));

  assert.equal(profile.userId, "profile-default");
  assert.equal(profile.agentId, "default");
  assert.equal(profile.name, "이설");
  assert.equal(profile.avatarUrl, "");
});

test("agent profile updates persist and remain isolated by authenticated user", async () => {
  const root = await mkdtemp(join(tmpdir(), "npc-agent-profile-"));
  const service = createAiAgentProfileService(root, { now: () => "2026-09-27T12:00:00.000Z" });

  const saved = await service.updateProfile(principal("profile-a"), {
    name: "이라그네프로",
    avatarUrl: "https://example.com/avatar.png",
    personality: "장난스럽고 실용적",
    tone: "반말",
    role: "프로젝트 동료",
  });
  const loaded = await service.getProfile(principal("profile-a"));
  const foreign = await service.getProfile(principal("profile-b"));

  assert.equal(saved.name, "이라그네프로");
  assert.equal(loaded.personality, "장난스럽고 실용적");
  assert.equal(foreign.name, "이설");
  assert.equal(foreign.personality, "사용자와 함께 배우고 만드는 개인 AI");
});

test("agent profile rejects invalid names, oversized text, and unsafe avatar URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "npc-agent-profile-"));
  const service = createAiAgentProfileService(root);
  const owner = principal("profile-validation");

  await assert.rejects(() => service.updateProfile(owner, { name: "   " }), /Agent name is required/);
  await assert.rejects(() => service.updateProfile(owner, { name: "x".repeat(41) }), /Agent name must be between/);
  await assert.rejects(() => service.updateProfile(owner, { avatarUrl: "javascript:alert(1)" }), /avatar URL/);
  await assert.rejects(() => service.updateProfile(owner, { personality: "x".repeat(501) }), /personality must be/);
});
