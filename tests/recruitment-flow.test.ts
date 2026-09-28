import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createActivityService } from "../src/activity/service.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createRecruitmentService } from "../src/recruitment/service.js";
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
