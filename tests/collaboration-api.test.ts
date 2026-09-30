import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createRecruitmentService } from "../src/recruitment/service.js";
import { createSocialService } from "../src/social/service.js";
import { createTeamService } from "../src/teams/service.js";
import { startWebControlPlaneServer } from "../src/web-control-plane/server.js";

test("collaboration API persists teams, recruitment, membership, friendship, and ACL-bound messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-collaboration-api-"));
  const users = createPlatformUserService(join(root, "platform"), { now: () => "2026-09-25T12:00:00.000Z" });
  const userA = await users.createUser({ id: "collab-api-a", email: "collab-a@example.com", displayName: "A", timezone: "Asia/Seoul" });
  const userB = await users.createUser({ id: "collab-api-b", email: "collab-b@example.com", displayName: "B", timezone: "Asia/Seoul" });
  const userC = await users.createUser({ id: "collab-api-c", email: "collab-c@example.com", displayName: "C", timezone: "Asia/Seoul" });
  const sessionA = await users.createSession({ userId: userA.id, roles: ["user"], expiresAt: "2026-09-26T12:00:00.000Z" });
  const sessionB = await users.createSession({ userId: userB.id, roles: ["user"], expiresAt: "2026-09-26T12:00:00.000Z" });
  const sessionC = await users.createSession({ userId: userC.id, roles: ["user"], expiresAt: "2026-09-26T12:00:00.000Z" });
  const teamService = createTeamService(join(root, "platform"), { now: () => "2026-09-25T12:00:00.000Z" });
  const server = await startWebControlPlaneServer({
    host: "127.0.0.1", port: 0, token: "operator", modelRoot: join(root, "model"), harnessRoot: join(root, "harness"), webRoot: resolve(process.cwd(), "web"),
    userService: users,
    teamService,
    socialService: createSocialService(join(root, "platform"), { platformUserService: users, canCollaborate: teamService.canCollaborate, now: () => "2026-09-25T12:00:00.000Z" }),
    recruitmentService: createRecruitmentService(join(root, "platform"), { teamService, now: () => "2026-09-25T12:00:00.000Z" }),
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
  try {
    const createdTeam = await fetch(`${url}/api/user/teams`, { method: "POST", headers: headers(sessionA.token), body: JSON.stringify({ name: "API team", description: "collab", kind: "project", visibility: "public", capacity: 3 }) });
    assert.equal(createdTeam.status, 201);
    const team = (await createdTeam.json() as any).team;
    const malformedTeamPath = await fetch(`${url}/api/user/teams/%E0%A4%A`, { headers: headers(sessionA.token) });
    assert.equal(malformedTeamPath.status, 404);
    const malformedRecruitmentPath = await fetch(`${url}/api/user/recruitment/%E0%A4%A`, { headers: headers(sessionA.token) });
    assert.equal(malformedRecruitmentPath.status, 404);
    const aiAdded = await fetch(`${url}/api/user/teams/${team.id}/ai-members`, { method: "POST", headers: headers(sessionA.token), body: JSON.stringify({ agentId: "api-frontend", assignmentRole: "frontend", capabilities: ["context.read", "task.propose"], approvalScope: "suggestion-only" }) });
    assert.equal(aiAdded.status, 201);
    const aiMember = (await aiAdded.json() as any).member;
    assert.equal(aiMember.memberType, "ai");
    assert.equal(aiMember.assignmentRole, "frontend");
    assert.deepEqual(aiMember.capabilities, ["context.read", "task.propose"]);
    const foreignAiAdd = await fetch(`${url}/api/user/teams/${team.id}/ai-members`, { method: "POST", headers: headers(sessionB.token), body: JSON.stringify({ agentId: "api-qa", assignmentRole: "qa", capabilities: ["task.propose"], approvalScope: "suggestion-only" }) });
    assert.equal(foreignAiAdd.status, 403);
    const aiRemoved = await fetch(`${url}/api/user/teams/${team.id}/ai-members/api-frontend`, { method: "DELETE", headers: headers(sessionA.token) });
    assert.equal(aiRemoved.status, 200);
    const createdPost = await fetch(`${url}/api/user/recruitment`, { method: "POST", headers: headers(sessionA.token), body: JSON.stringify({ teamId: team.id, kind: "project", title: "Join API team", description: "work together", roles: ["frontend"], tags: ["React"] }) });
    assert.equal(createdPost.status, 201);
    const post = (await createdPost.json() as any).post;
    const applied = await fetch(`${url}/api/user/recruitment/${post.id}/applications`, { method: "POST", headers: headers(sessionB.token), body: JSON.stringify({ message: "Please accept me" }) });
    assert.equal(applied.status, 201);
    const application = (await applied.json() as any).application;
    const accepted = await fetch(`${url}/api/user/recruitment/applications/${application.id}`, { method: "POST", headers: headers(sessionA.token), body: JSON.stringify({ action: "accept" }) });
    assert.equal(accepted.status, 200);
    const sent = await fetch(`${url}/api/user/social/messages?userId=${userA.id}`, { method: "POST", headers: headers(sessionB.token), body: JSON.stringify({ body: "team message" }) });
    assert.equal(sent.status, 201);
    const foreign = await fetch(`${url}/api/user/social/messages?userId=${userA.id}`, { headers: headers(sessionC.token) });
    assert.equal(foreign.status, 403);
    const teamList = await fetch(`${url}/api/user/teams`, { headers: headers(sessionB.token) });
    assert.equal((await teamList.json() as any).teams.some((item: any) => item.id === team.id), true);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
});
