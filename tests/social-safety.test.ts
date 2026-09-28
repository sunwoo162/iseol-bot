import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createSocialService } from "../src/social/service.js";

const at = "2026-09-27T15:00:00.000Z";
const principal = (userId: string): Principal => ({ userId, sessionId: `${userId}-session`, roles: ["user"] });

test("blocking prevents social discovery, friendship, and messages while preserving a durable private report", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-safety-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["safety-a", "safety-b", "safety-c"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const social = createSocialService(platformRoot, { platformUserService: users, now: () => at });
  await social.createFriendRequest(principal("safety-a"), "safety-b");
  await social.respondToFriendRequest(principal("safety-b"), "friend-safety-a-safety-b", "accept");
  const block = await social.blockUser(principal("safety-a"), "safety-b");
  assert.equal(block.status, "active");
  assert.equal((await social.listFriends(principal("safety-a"))).length, 0);
  assert.equal((await social.listFriends(principal("safety-b"))).length, 0);
  assert.equal((await social.listProfiles(principal("safety-b"), "safety-a")).length, 0);
  await assert.rejects(() => social.sendDirectMessage(principal("safety-b"), "safety-a", "blocked"), /blocked/i);
  await assert.rejects(() => social.createFriendRequest(principal("safety-b"), "safety-a"), /blocked/i);
  const report = await social.reportUser(principal("safety-a"), "safety-b", "harassment in direct messages");
  assert.equal(report.reporterUserId, "safety-a");
  assert.equal((await social.listReports(principal("safety-b"))).length, 0);
  assert.equal((await social.listReports(principal("safety-a"))).length, 1);

  await social.unblockUser(principal("safety-a"), "safety-b");
  assert.equal((await social.listProfiles(principal("safety-b"), "safety-a"))[0]?.userId, "safety-a");
  assert.equal((await social.listFriends(principal("safety-a"))).length, 1);
});

test("social safety operations reject self-targets and unknown users", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-safety-invalid-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  await users.createUser({ id: "safety-only", email: "safety-only@example.com", displayName: "Safety only", timezone: "Asia/Seoul" });
  const social = createSocialService(platformRoot, { platformUserService: users, now: () => at });
  await assert.rejects(() => social.blockUser(principal("safety-only"), "safety-only"), /yourself/i);
  await assert.rejects(() => social.reportUser(principal("safety-only"), "missing-user", "spam"), /not found/i);
});
