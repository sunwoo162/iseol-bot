import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { withDurableSocialBlockLock } from "../src/social/block-lock.js";
import { createSocialService } from "../src/social/service.js";
import { saveBlock } from "../src/social/store.js";

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

test("blocking prevents a pending friend request from being accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-safety-pending-friend-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["pending-friend-a", "pending-friend-b"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const social = createSocialService(platformRoot, { platformUserService: users, now: () => at });

  const request = await social.createFriendRequest(principal("pending-friend-a"), "pending-friend-b");
  await social.blockUser(principal("pending-friend-b"), "pending-friend-a");
  await assert.rejects(() => social.respondToFriendRequest(principal("pending-friend-b"), request.request.id, "accept"), /blocked/i);

  await social.unblockUser(principal("pending-friend-b"), "pending-friend-a");
  assert.equal((await social.listIncomingFriendRequests(principal("pending-friend-b"))).length, 1);
  assert.equal((await social.respondToFriendRequest(principal("pending-friend-b"), request.request.id, "accept")).status, "accepted");
});

test("concurrent block mutations across service instances preserve one active block", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-block-concurrent-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  await users.createUser({ id: "block-owner", email: "block-owner@example.com", displayName: "Block owner", timezone: "Asia/Seoul" });
  const targets = Array.from({ length: 24 }, (_, index) => `block-target-${index}`);
  for (const target of targets) await users.createUser({ id: target, email: `${target}@example.com`, displayName: target, timezone: "Asia/Seoul" });
  const firstService = createSocialService(platformRoot, { platformUserService: users, now: () => at });
  const secondService = createSocialService(platformRoot, { platformUserService: users, now: () => at });

  const results = await Promise.allSettled(targets.flatMap((target) => [
    firstService.blockUser(principal("block-owner"), target),
    secondService.blockUser(principal("block-owner"), target),
  ]));

  assert.equal(results.filter((result) => result.status === "fulfilled").length, targets.length * 2);
  assert.equal((await firstService.listBlocks(principal("block-owner"))).length, targets.length);
  assert.ok((await firstService.listBlocks(principal("block-owner"))).every((block) => block.status === "active"));
});

test("public profile reads re-check social block state after waiting for the pair lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-profile-read-lock-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["profile-read-viewer", "profile-read-target"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const social = createSocialService(platformRoot, { platformUserService: users, now: () => at });

  let release!: () => void;
  let acquired!: () => void;
  const holderAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withDurableSocialBlockLock(platformRoot, "profile-read-viewer", "profile-read-target", async () => {
    acquired();
    await new Promise<void>((resolve) => { release = resolve; });
  }, { waitForMs: 0 });
  await holderAcquired;

  let settled = false;
  const reading = social.getProfile(principal("profile-read-viewer"), "profile-read-target").then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  await saveBlock(platformRoot, { version: 1, id: "block-profile-read-viewer-profile-read-target", blockerUserId: "profile-read-viewer", blockedUserId: "profile-read-target", status: "active", createdAt: at, updatedAt: at });
  release();
  assert.equal(await reading, null);
  await holder;
});

test("friend list reads re-check social block state after waiting for the pair lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-friends-read-lock-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["friends-read-a", "friends-read-b"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const social = createSocialService(platformRoot, { platformUserService: users, now: () => at });
  await social.createFriendRequest(principal("friends-read-a"), "friends-read-b");
  await social.respondToFriendRequest(principal("friends-read-b"), "friend-friends-read-a-friends-read-b", "accept");

  let release!: () => void;
  let acquired!: () => void;
  const holderAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withDurableSocialBlockLock(platformRoot, "friends-read-a", "friends-read-b", async () => {
    acquired();
    await new Promise<void>((resolve) => { release = resolve; });
  }, { waitForMs: 0 });
  await holderAcquired;

  let settled = false;
  const reading = social.listFriends(principal("friends-read-a")).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  await saveBlock(platformRoot, { version: 1, id: "block-friends-read-a-friends-read-b", blockerUserId: "friends-read-a", blockedUserId: "friends-read-b", status: "active", createdAt: at, updatedAt: at });
  release();
  assert.deepEqual(await reading, []);
  await holder;
});

test("incoming friend request reads re-check social block state after waiting for the pair lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-incoming-read-lock-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["incoming-read-requester", "incoming-read-target"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const social = createSocialService(platformRoot, { platformUserService: users, now: () => at });
  await social.createFriendRequest(principal("incoming-read-requester"), "incoming-read-target");

  let release!: () => void;
  let acquired!: () => void;
  const holderAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withDurableSocialBlockLock(platformRoot, "incoming-read-requester", "incoming-read-target", async () => {
    acquired();
    await new Promise<void>((resolve) => { release = resolve; });
  }, { waitForMs: 0 });
  await holderAcquired;

  let settled = false;
  const reading = social.listIncomingFriendRequests(principal("incoming-read-target")).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  await saveBlock(platformRoot, { version: 1, id: "block-incoming-read-target-incoming-read-requester", blockerUserId: "incoming-read-target", blockedUserId: "incoming-read-requester", status: "active", createdAt: at, updatedAt: at });
  release();
  assert.deepEqual(await reading, []);
  await holder;
});

test("profile list reads re-check social block state after waiting for the pair lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-social-profile-list-read-lock-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["profile-list-viewer", "profile-list-target"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const social = createSocialService(platformRoot, { platformUserService: users, now: () => at });
  await social.updateProfile(principal("profile-list-target"), { handle: "profile-list-target" });

  let release!: () => void;
  let acquired!: () => void;
  const holderAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withDurableSocialBlockLock(platformRoot, "profile-list-viewer", "profile-list-target", async () => {
    acquired();
    await new Promise<void>((resolve) => { release = resolve; });
  }, { waitForMs: 0 });
  await holderAcquired;

  let settled = false;
  const reading = social.listProfiles(principal("profile-list-viewer"), "profile-list-target").then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  await saveBlock(platformRoot, { version: 1, id: "block-profile-list-viewer-profile-list-target", blockerUserId: "profile-list-viewer", blockedUserId: "profile-list-target", status: "active", createdAt: at, updatedAt: at });
  release();
  assert.deepEqual(await reading, []);
  await holder;
});
