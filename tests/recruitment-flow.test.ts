import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createActivityService } from "../src/activity/service.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createRecruitmentService } from "../src/recruitment/service.js";
import { withDurableTeamMembershipLock } from "../src/teams/membership-lock.js";
import { loadMembership, saveMembership } from "../src/teams/store.js";
import { createTeamService } from "../src/teams/service.js";

const at = "2026-09-25T12:00:00.000Z";
const principal = (userId: string): Principal => ({ userId, sessionId: `${userId}-session`, roles: ["user"] });

test("recruitment application acceptance adds a member and rejects duplicate access paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-recruitment-"));
  const users = createPlatformUserService(join(root, "platform"), { now: () => at });
  for (const id of ["recruit-a", "recruit-b", "recruit-c"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const activity = createActivityService(join(root, "platform"), { now: () => at });
  const teams = createTeamService(join(root, "platform"), { now: () => at, activityService: activity });
  const recruitment = createRecruitmentService(join(root, "platform"), { teamService: teams, activityService: activity, now: () => at });
  const team = await teams.createTeam(principal("recruit-a"), { name: "Project", description: "build together", kind: "project", visibility: "public", capacity: 2 });
  const post = await recruitment.createPost(principal("recruit-a"), { teamId: team.id, kind: "project", title: "Need a frontend member", description: "ship a small app", roles: ["frontend"], tags: ["React"] });
  assert.equal((await activity.listActivityEvents(principal("recruit-a"))).some((event) => event.eventType === "recruitment.post.created" && event.sourceId === post.id), true);

  const first = await recruitment.apply(principal("recruit-b"), post.id, "I would like to join.");
  const repeated = await recruitment.apply(principal("recruit-b"), post.id, "same application");
  assert.equal(first.created, true);
  assert.equal((await activity.listActivityEvents(principal("recruit-b"))).some((event) => event.eventType === "recruitment.application.created" && event.sourceId === first.application.id), true);
  assert.equal(repeated.created, false);
  assert.equal((await recruitment.getPost(principal("recruit-a"), post.id))?.applications.length, 1);

  await assert.rejects(() => recruitment.reviewApplication(principal("recruit-c"), first.application.id, "accept"), /manager access|not found/i);
  const accepted = await recruitment.reviewApplication(principal("recruit-a"), first.application.id, "accept");
  assert.equal(accepted.status, "accepted");
  assert.equal((await activity.listActivityEvents(principal("recruit-a"))).some((event) => event.eventType === "recruitment.application.reviewed" && event.sourceId === first.application.id), true);
  assert.equal((await teams.listMemberships(team.id)).some((member) => member.userId === "recruit-b"), true);
  await assert.rejects(() => recruitment.apply(principal("recruit-b"), post.id, "already joined"), /already a team member/i);
});

test("concurrent recruitment applications across service instances remain one pending application", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-recruitment-concurrent-"));
  const platform = join(root, "platform");
  const users = createPlatformUserService(platform, { now: () => at });
  for (const id of ["recruit-concurrent-owner", "recruit-concurrent-applicant"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const teams = createTeamService(platform, { now: () => at });
  const activity = createActivityService(platform, { now: () => at });
  const firstService = createRecruitmentService(platform, { teamService: teams, activityService: activity, now: () => at });
  const secondService = createRecruitmentService(platform, { teamService: teams, activityService: activity, now: () => at });
  const team = await teams.createTeam(principal("recruit-concurrent-owner"), { name: "Concurrent Project", description: "build together", kind: "project", visibility: "public", capacity: 4 });
  const post = await firstService.createPost(principal("recruit-concurrent-owner"), { teamId: team.id, kind: "project", title: "Concurrent application", description: "accept one application record", roles: ["frontend"], tags: [] });

  const results = await Promise.all([
    firstService.apply(principal("recruit-concurrent-applicant"), post.id, "same application"),
    secondService.apply(principal("recruit-concurrent-applicant"), post.id, "same application"),
  ]);

  assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
  assert.equal((await firstService.getPost(principal("recruit-concurrent-owner"), post.id))?.applications.length, 1);
});

test("concurrent recruitment application decisions keep one terminal review", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-recruitment-review-concurrent-"));
  const platform = join(root, "platform");
  const users = createPlatformUserService(platform, { now: () => at });
  for (const id of ["recruit-review-owner", "recruit-review-applicant"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const teams = createTeamService(platform, { now: () => at });
  const activity = createActivityService(platform, { now: () => at });
  const firstService = createRecruitmentService(platform, { teamService: teams, activityService: activity, now: () => at });
  const secondService = createRecruitmentService(platform, { teamService: teams, activityService: activity, now: () => at });
  const team = await teams.createTeam(principal("recruit-review-owner"), { name: "Review Project", description: "serialize review", kind: "project", visibility: "public", capacity: 4 });
  const post = await firstService.createPost(principal("recruit-review-owner"), { teamId: team.id, kind: "project", title: "Review application", description: "one terminal decision", roles: ["frontend"], tags: [] });
  const application = (await firstService.apply(principal("recruit-review-applicant"), post.id, "Please review me.")).application;

  const results = await Promise.allSettled([
    firstService.reviewApplication(principal("recruit-review-owner"), application.id, "accept"),
    secondService.reviewApplication(principal("recruit-review-owner"), application.id, "reject"),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && /not found|pending|review/i.test(String(result.reason))).length, 1);
  const stored = (await firstService.getPost(principal("recruit-review-owner"), post.id))?.applications[0];
  assert.ok(stored?.status === "accepted" || stored?.status === "rejected");
});

test("recruitment applications re-check post and team membership after waiting for the Team lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-recruitment-apply-lock-"));
  const platform = join(root, "platform");
  const users = createPlatformUserService(platform, { now: () => at });
  for (const id of ["recruit-apply-owner", "recruit-apply-applicant"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const teams = createTeamService(platform, { now: () => at });
  const recruitment = createRecruitmentService(platform, { teamService: teams, now: () => at });
  const team = await teams.createTeam(principal("recruit-apply-owner"), { name: "Apply lock team", description: "recheck applicant access", kind: "project", visibility: "public", capacity: 3 });
  const post = await recruitment.createPost(principal("recruit-apply-owner"), { teamId: team.id, kind: "project", title: "Apply lock post", description: "recheck post and membership", roles: ["member"], tags: [] });

  let release!: () => void;
  let acquired!: () => void;
  const holderAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withDurableTeamMembershipLock(platform, team.id, async () => {
    acquired();
    await new Promise<void>((resolve) => { release = resolve; });
  }, { waitForMs: 0 });
  await holderAcquired;

  const apply = recruitment.apply(principal("recruit-apply-applicant"), post.id, "I want to join.");
  assert.equal(await Promise.race([
    apply.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 40)),
  ]), false);
  await saveMembership(platform, { version: 1, id: `${team.id}:recruit-apply-applicant`, teamId: team.id, userId: "recruit-apply-applicant", memberType: "human", role: "member", assignmentRole: "member", capabilities: [], approvalScope: "suggestion-only", status: "active", joinedAt: at, updatedAt: at });
  release();
  await Promise.all([holder, assert.rejects(() => apply, /already a team member/i)]);
  assert.equal((await recruitment.getPost(principal("recruit-apply-owner"), post.id))?.applications.length, 0);
});

test("recruitment post reads re-check manager access after waiting for the Team lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-recruitment-read-lock-"));
  const platform = join(root, "platform");
  const users = createPlatformUserService(platform, { now: () => at });
  for (const id of ["recruit-read-owner", "recruit-read-applicant"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const teams = createTeamService(platform, { now: () => at });
  const recruitment = createRecruitmentService(platform, { teamService: teams, now: () => at });
  const team = await teams.createTeam(principal("recruit-read-owner"), { name: "Read lock team", description: "manager read recheck", kind: "project", visibility: "public", capacity: 3 });
  const post = await recruitment.createPost(principal("recruit-read-owner"), { teamId: team.id, kind: "project", title: "Read lock post", description: "applications are private to managers", roles: ["member"], tags: [] });
  await recruitment.apply(principal("recruit-read-applicant"), post.id, "Please review me.");

  let release!: () => void;
  let acquired!: () => void;
  const holderAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const holder = withDurableTeamMembershipLock(platform, team.id, async () => {
    acquired();
    await new Promise<void>((resolve) => { release = resolve; });
  }, { waitForMs: 0 });
  await holderAcquired;

  let settled = false;
  const reading = recruitment.getPost(principal("recruit-read-owner"), post.id).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  const membership = await loadMembership(platform, team.id, "recruit-read-owner");
  assert.ok(membership);
  await saveMembership(platform, { ...membership, status: "removed", updatedAt: at });
  release();
  const result = await reading;
  assert.deepEqual(result?.applications, []);
  await holder;
});
