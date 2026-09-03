import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGitHubConnectModalId,
  buildProjectGitHubId,
  findDuplicateGitHubAccount,
  githubAccountActionPlan,
  githubAccountPanel,
  githubJoinUsername,
  normalizeGitHubUsername,
  parseGitHubConnectModalId,
  parseProjectGitHubId,
} from "../src/services/github-account-discord.js";
import type { GitHubAccountLink } from "../src/services/github-user.js";
import type { StoredProject } from "../src/services/projects.js";

const projectFixture: StoredProject = {
  id: "p1",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "category1",
  organization: "rain-gj",
  frontend: {
    owner: "rain-gj",
    repo: "frontend",
    url: "https://github.com/rain-gj/frontend",
  },
  backend: {
    owner: "rain-gj",
    repo: "backend",
    url: "https://github.com/rain-gj/backend",
  },
};

const linkedAccount: GitHubAccountLink = {
  guildId: "guild1",
  discordUserId: "user1",
  githubLogin: "sunwoo162",
  connectedAt: "2026-09-01T00:00:00.000Z",
};

function customIds(payload: ReturnType<typeof githubAccountPanel>): string[] {
  return payload.components.flatMap((row) =>
    row.components
      .map((item) => item.data.custom_id)
      .filter((value): value is string => Boolean(value)),
  );
}

test("project github custom ids round-trip", () => {
  const id = buildProjectGitHubId("connect", "p1");
  assert.equal(id, "project_github:connect:p1");
  assert.deepEqual(parseProjectGitHubId(id), { action: "connect", projectId: "p1" });
  assert.deepEqual(parseProjectGitHubId("project_github:join:p1"), { action: "join", projectId: "p1" });
  assert.equal(parseProjectGitHubId("project_github:invite:p1"), null);
});

test("github connect modal id preserves project context", () => {
  const id = buildGitHubConnectModalId("p1");
  assert.equal(id, "project_github_connect_modal:p1");
  assert.deepEqual(parseGitHubConnectModalId(id), { projectId: "p1" });
  assert.equal(parseGitHubConnectModalId("project_github_connect:p1"), null);
});

test("github username input is normalized and validated once", () => {
  assert.equal(normalizeGitHubUsername("  @SunWoo162  "), "SunWoo162");
  assert.throws(() => normalizeGitHubUsername("-invalid"), /올바른 GitHub 사용자명/);
  assert.throws(() => normalizeGitHubUsername(""), /올바른 GitHub 사용자명/);
});

test("unlinked github panel exposes connect but not join", () => {
  const payload = githubAccountPanel(projectFixture, null);
  const ids = customIds(payload);
  assert.ok(ids.includes("project_github:connect:p1"));
  assert.ok(!ids.includes("project_github:join:p1"));
  assert.ok(!ids.includes("project_github:disconnect:p1"));
  assert.match(payload.content, /GitHub 계정 연결/);
});

test("linked github panel reuses stored identity for project join", () => {
  const payload = githubAccountPanel(projectFixture, linkedAccount);
  const ids = customIds(payload);
  assert.match(payload.content, /@sunwoo162/);
  assert.ok(ids.includes("project_github:join:p1"));
  assert.ok(ids.includes("project_github:profile:p1"));
  assert.ok(ids.includes("project_github:disconnect:p1"));
  assert.equal(githubJoinUsername(linkedAccount), "sunwoo162");
  assert.equal(githubJoinUsername(null), null);
});

test("github action plan never asks for username again after linking", () => {
  assert.deepEqual(githubAccountActionPlan("connect", null), { kind: "connect" });
  assert.deepEqual(githubAccountActionPlan("join", null), { kind: "connect_required" });
  assert.deepEqual(githubAccountActionPlan("profile", null), { kind: "connect_required" });
  assert.deepEqual(githubAccountActionPlan("disconnect", null), { kind: "not_linked" });
  assert.deepEqual(githubAccountActionPlan("join", linkedAccount), { kind: "join", username: "sunwoo162" });
  assert.deepEqual(githubAccountActionPlan("profile", linkedAccount), { kind: "profile", username: "sunwoo162" });
  assert.deepEqual(githubAccountActionPlan("disconnect", linkedAccount), { kind: "disconnect", username: "sunwoo162" });
});

test("duplicate github identity detection is guild scoped and ignores current user", () => {
  const links: GitHubAccountLink[] = [
    linkedAccount,
    { ...linkedAccount, guildId: "guild2", discordUserId: "user2" },
  ];
  assert.equal(findDuplicateGitHubAccount(links, "guild1", "user2", "SUNWOO162")?.discordUserId, "user1");
  assert.equal(findDuplicateGitHubAccount(links, "guild1", "user1", "sunwoo162"), null);
  assert.equal(findDuplicateGitHubAccount(links, "guild3", "user3", "sunwoo162"), null);
});
