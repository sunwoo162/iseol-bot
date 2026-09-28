import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createTeamService } from "../src/teams/service.js";
import { createTeamChatService } from "../src/team-chat/service.js";

const at = "2026-09-27T12:00:00.000Z";
const principal = (userId: string): Principal => ({ userId, sessionId: `${userId}-session`, roles: ["user"] });

test("team chat is durable and readable only by active human members", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-team-chat-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => at });
  for (const id of ["chat-owner", "chat-member", "chat-outsider"]) await users.createUser({ id, email: `${id}@example.com`, displayName: id, timezone: "Asia/Seoul" });
  const teams = createTeamService(platformRoot, { now: () => at });
  const team = await teams.createTeam(principal("chat-owner"), { name: "Team chat", description: "membership scoped chat", kind: "project", visibility: "public", capacity: 4 });
  await teams.addMember(team.id, "chat-member", "member");
  const chat = createTeamChatService(platformRoot, { teamService: teams, now: () => at });

  const first = await chat.sendMessage(principal("chat-owner"), team.id, "첫 번째 팀 메시지");
  assert.equal(first.senderUserId, "chat-owner");
  await chat.sendMessage(principal("chat-member"), team.id, "멤버의 답장");
  assert.deepEqual((await chat.listMessages(principal("chat-member"), team.id)).map((item) => item.body).sort(), ["첫 번째 팀 메시지", "멤버의 답장"].sort());
  const restarted = createTeamChatService(platformRoot, { teamService: teams, now: () => at });
  assert.equal((await restarted.listMessages(principal("chat-owner"), team.id)).length, 2);
  await assert.rejects(() => restarted.listMessages(principal("chat-outsider"), team.id), /membership/i);
  await teams.leaveTeam(principal("chat-member"), team.id);
  await assert.rejects(() => restarted.listMessages(principal("chat-member"), team.id), /membership/i);
  await assert.rejects(() => restarted.sendMessage(principal("chat-member"), team.id, "떠난 뒤 메시지"), /membership/i);
  assert.equal((await restarted.listMessages(principal("chat-owner"), team.id)).length, 2);
});

test("team chat rejects blank and oversized messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-team-chat-validation-"));
  const teams = createTeamService(root, { now: () => at });
  const owner = principal("validation-owner");
  const users = createPlatformUserService(root, { now: () => at });
  await users.createUser({ id: owner.userId, email: "validation@example.com", displayName: "validation", timezone: "Asia/Seoul" });
  const team = await teams.createTeam(owner, { name: "Validation team", description: "chat validation", kind: "study", visibility: "private", capacity: 2 });
  const chat = createTeamChatService(root, { teamService: teams, now: () => at });
  await assert.rejects(() => chat.sendMessage(owner, team.id, "   "), /message/i);
  await assert.rejects(() => chat.sendMessage(owner, team.id, "x".repeat(10_001)), /message/i);
});
