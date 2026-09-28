import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createTeamService } from "../src/teams/service.js";
import { createStudyService } from "../src/study/service.js";

const at = "2026-09-27T14:00:00.000Z";
const principal = (userId: string): Principal => ({ userId, sessionId: `${userId}-session`, roles: ["user"] });

test("study spaces expose shared curriculum and tasks while personal submissions stay private and durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-study-space-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["study-owner", "study-member", "study-outsider"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const teams = createTeamService(platformRoot, { now: () => at });
  const team = await teams.createTeam(principal("study-owner"), { name: "TypeScript study", description: "shared curriculum", kind: "study", visibility: "private", capacity: 4 });
  await teams.addMember(team.id, "study-member", "member", at);
  const studies = createStudyService(join(platformRoot, "study"), { teamService: teams, now: () => at });

  const space = await studies.createStudySpace(principal("study-owner"), { teamId: team.id, title: "TypeScript foundations", description: "shared lessons and tasks" });
  const link = await studies.addCurriculumLink(principal("study-owner"), space.id, { kind: "resource", referenceId: "typescript-handbook", label: "TypeScript Handbook" });
  const task = await studies.createTask(principal("study-owner"), space.id, { title: "Explain narrowing", instructions: "Write one example of control-flow narrowing", dueLocalDate: "2026-09-30" });

  const memberView = await studies.getStudySpace(principal("study-member"), space.id);
  assert.ok(memberView);
  assert.equal(memberView.space.teamId, team.id);
  assert.deepEqual(memberView.curriculumLinks.map((item) => item.id), [link.id]);
  assert.deepEqual(memberView.tasks.map((item) => item.id), [task.id]);
  assert.deepEqual(memberView.mySubmissions, []);

  const submission = await studies.saveTaskSubmission(principal("study-member"), space.id, task.id, { answer: "A value check narrows a union in the guarded branch.", status: "submitted" });
  assert.equal(submission.userId, "study-member");
  assert.equal((await studies.getStudySpace(principal("study-member"), space.id))?.mySubmissions[0]?.answer, submission.answer);
  assert.deepEqual((await studies.getStudySpace(principal("study-owner"), space.id))?.mySubmissions, []);
  assert.equal(await studies.getStudySpace(principal("study-outsider"), space.id), null);

  const restarted = createStudyService(join(platformRoot, "study"), { teamService: teams, now: () => at });
  assert.equal((await restarted.getStudySpace(principal("study-member"), space.id))?.mySubmissions[0]?.id, submission.id);
});

test("study managers alone can create shared curriculum and tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-study-manager-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["study-manager", "study-member"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const teams = createTeamService(platformRoot, { now: () => at });
  const team = await teams.createTeam(principal("study-manager"), { name: "Study manager team", description: "manager boundary", kind: "study", visibility: "public", capacity: 3 });
  await teams.addMember(team.id, "study-member", "member", at);
  const studies = createStudyService(join(platformRoot, "study"), { teamService: teams, now: () => at });
  const space = await studies.createStudySpace(principal("study-manager"), { teamId: team.id, title: "Shared room", description: "controlled study space" });
  await assert.rejects(() => studies.createStudySpace(principal("study-member"), { teamId: team.id, title: "Another room", description: "not allowed" }), /manager/i);
  await assert.rejects(() => studies.addCurriculumLink(principal("study-member"), space.id, { kind: "resource", referenceId: "x", label: "x" }), /manager/i);
  await assert.rejects(() => studies.createTask(principal("study-member"), space.id, { title: "x", instructions: "x" }), /manager/i);
});
