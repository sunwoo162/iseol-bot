import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createActivityService } from "../src/activity/service.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createSocialService } from "../src/social/service.js";

const at = "2026-09-25T12:00:00.000Z";
const principal = (userId: string): Principal => ({ userId, sessionId: `${userId}-session`, roles: ["user"] });

test("direct messages require accepted friendship and remain private", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-"));
  const users = createPlatformUserService(join(root, "platform"), { now: () => at });
  for (const id of ["social-a", "social-b", "social-c"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const activity = createActivityService(join(root, "platform"), { now: () => at });
  const social = createSocialService(join(root, "platform"), { platformUserService: users, activityService: activity, now: () => at });
  await social.updateProfile(principal("social-a"), { handle: "alice", skills: ["TypeScript"] });
  const friendRequest = await social.createFriendRequest(principal("social-a"), "social-b");
  assert.equal((await activity.listActivityEvents(principal("social-a"))).some((event) => event.eventType === "friend.request.created" && event.sourceId === friendRequest.request.id), true);
  await assert.rejects(() => social.sendDirectMessage(principal("social-a"), "social-b", "too early"), /accepted friendship|shared team/i);
  const request = (await social.listIncomingFriendRequests(principal("social-b")))[0];
  assert.equal(request?.requester?.handle, "alice");
  await social.respondToFriendRequest(principal("social-b"), request!.id, "accept");
  assert.equal((await activity.listActivityEvents(principal("social-b"))).some((event) => event.eventType === "friend.request.accepted" && event.sourceId === request!.id), true);
  const message = await social.sendDirectMessage(principal("social-a"), "social-b", "hello");
  assert.equal((await activity.listActivityEvents(principal("social-a"))).some((event) => event.eventType === "message.sent" && event.sourceId === message.id), true);
  assert.equal((await social.listDirectMessages(principal("social-b"), "social-a")).length, 1);
  await assert.rejects(() => social.listDirectMessages(principal("social-c"), "social-a"), /accepted friendship|shared team/i);
  assert.equal((await social.listProfiles(principal("social-c"), "alice"))[0]?.displayName, "social-a");
});
