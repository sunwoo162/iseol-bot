import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectHubId,
  parseProjectHubId,
} from "../src/services/project-experience/project-custom-id.js";
import {
  projectHealthIssues,
  projectHealthLines,
  storedProjectHealth,
  type ProjectHealth,
} from "../src/services/project-experience/project-health.js";
import {
  ensureProjectHub,
  ensureProjectHubGuide,
  projectHubActionCopy,
  projectHubAdvancedMessage,
  projectHubMessage,
} from "../src/services/project-experience/project-hub.js";
import {
  buildProjectConnectId,
  parseProjectConnectId,
  projectGitHubPermissionGuide,
  projectQuickConnectPanel,
} from "../src/services/project-experience/project-connect.js";
import type { StoredProject } from "../src/services/projects.js";

const projectFixture: StoredProject = {
  id: "abc123",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "category1",
  organization: "rain-gj",
  frontend: { owner: "rain-gj", repo: "frontend", url: "https://github.com/rain-gj/frontend" },
  backend: { owner: "rain-gj", repo: "backend", url: "https://github.com/rain-gj/backend" },
  notionUrl: "https://www.notion.so/0123456789abcdef0123456789abcdef",
  figmaUrl: "https://www.figma.com/design/example/file",
};

const connectedHealthFixture: ProjectHealth = {
  github: "connected", review: "connected", calendar: "connected", scrum: "connected", notion: "connected", figma: "connected",
};

const incompleteHealthFixture: ProjectHealth = {
  github: "repair", review: "checking", calendar: "needs_setup", scrum: "connected", notion: "connected", figma: "connected",
};

test("project hub custom ids round-trip", () => {
  const id = buildProjectHubId("calendar", "abc123");
  assert.equal(id, "project_hub:calendar:abc123");
  assert.deepEqual(parseProjectHubId(id), { action: "calendar", projectId: "abc123" });
  assert.deepEqual(parseProjectHubId("project_hub:more:abc123"), { action: "more", projectId: "abc123" });
  assert.equal(parseProjectHubId("calendar:add:abc123"), null);
});

test("project health uses short user-facing states", () => {
  const lines = projectHealthLines({ github: "connected", review: "needs_admin", calendar: "needs_setup", scrum: "connected", notion: "connected", figma: "needs_setup" });
  assert.ok(lines.some((line) => line.includes("GitHub 프로젝트") && line.includes("연결됨")));
  assert.ok(lines.some((line) => line.includes("Code Review") && line.includes("관리자 설정 필요")));
  assert.ok(lines.some((line) => line.includes("Google Calendar") && line.includes("설정 필요")));
  assert.ok(lines.every((line) => !line.includes("403")));
});

test("stored project health uses one shared diagnostic rule", () => {
  const healthy = storedProjectHealth({ ...projectFixture, frontendHookId: 1, backendHookId: 2, calendarId: "calendar1", scrumChannelId: "scrum1", scrumPanelMessageId: "scrum-panel1" });
  assert.deepEqual(healthy, { github: "connected", review: "checking", calendar: "connected", scrum: "connected", notion: "connected", figma: "connected" });
  const incomplete = storedProjectHealth({ ...projectFixture, notionUrl: undefined, figmaUrl: undefined });
  assert.equal(incomplete.github, "repair");
  assert.equal(incomplete.calendar, "needs_setup");
  assert.equal(incomplete.scrum, "repair");
  assert.equal(incomplete.notion, "needs_setup");
  assert.equal(incomplete.figma, "needs_setup");
});

test("project health issues stay actionable and hide raw api details", () => {
  const issues = projectHealthIssues({ github: "repair", review: "needs_admin", calendar: "needs_setup", scrum: "repair", notion: "needs_setup", figma: "connected" });
  assert.ok(issues.some((line) => line.includes("GitHub") && line.includes("복구")));
  assert.ok(issues.some((line) => line.includes("Code Review") && line.includes("관리자")));
  assert.ok(issues.every((line) => !/403|HTTP|token|PAT/i.test(line)));
});

test("project hub primary row is task first", () => {
  const payload = projectHubMessage(projectFixture, connectedHealthFixture);
  const ids = payload.components.flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.deepEqual(ids, ["project_task:create:abc123", "project_task:my:abc123", "project_hub:scrum:abc123", "project_hub:github:abc123", "project_hub:more:abc123"]);
});

test("project hub exposes one quick integration button only when action is needed", () => {
  const incomplete = projectHubMessage(projectFixture, incompleteHealthFixture);
  const incompleteIds = incomplete.components.flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.ok(incompleteIds.includes("project_connect:open:abc123"));
  const connected = projectHubMessage(projectFixture, connectedHealthFixture);
  const connectedIds = connected.components.flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.ok(!connectedIds.includes("project_connect:open:abc123"));
});

test("quick integration panel keeps all setup actions in one place", () => {
  assert.equal(buildProjectConnectId("auto", "abc123"), "project_connect:auto:abc123");
  assert.deepEqual(parseProjectConnectId("project_connect:calendar:abc123"), { action: "calendar", projectId: "abc123" });
  const payload = projectQuickConnectPanel(projectFixture, incompleteHealthFixture);
  const ids = payload.components.flatMap((row) => row.components.map((component) => component.data.custom_id).filter((value): value is string => Boolean(value)));
  assert.deepEqual(ids, [
    "project_connect:auto:abc123",
    "project_connect:github:abc123",
    "project_connect:calendar:abc123",
    "project_settings:notion:abc123",
    "project_settings:figma:abc123",
    "project_connect:github_help:abc123",
  ]);
});

test("github permission guide is actionable without exposing a secret input", () => {
  const payload = projectGitHubPermissionGuide(projectFixture);
  const text = payload.embeds[0]?.data.description ?? "";
  assert.match(text, /Workflows.*Read\/write/i);
  assert.match(text, /Pull requests.*Read\/write/i);
  assert.match(text, /Webhooks.*Read\/write/i);
  assert.ok(!/토큰 입력|token 입력/i.test(text));
  const urls = payload.components.flatMap((row) => row.components.map((component) => component.data.url).filter(Boolean));
  assert.ok(urls.some((url) => url?.includes("github.com/settings/personal-access-tokens")));
});

test("advanced hub keeps calendar review refresh and admin compatibility", () => {
  const payload = projectHubAdvancedMessage(projectFixture, connectedHealthFixture);
  const ids = payload.components.flatMap((row) => row.components.map((component) => component.data.custom_id).filter(Boolean));
  assert.ok(ids.includes("project_hub:calendar:abc123"));
  assert.ok(ids.includes("project_hub:review:abc123"));
  assert.ok(ids.includes("project_hub:refresh:abc123"));
  assert.ok(ids.includes("project_hub:admin:abc123"));
});

test("every project hub action has user-facing copy", () => {
  for (const action of ["calendar", "scrum", "github", "review", "refresh", "admin", "more"] as const) assert.ok(projectHubActionCopy(action).trim().length > 0);
});

test("live project hub is unpinned while keeping its interactive payload", async () => {
  let unpinned = false;
  const message = { id: "live-hub", pinned: true, edit: async () => undefined, unpin: async () => { unpinned = true; } };
  const channel = { messages: { fetch: async () => message }, send: async () => { throw new Error("must reuse live hub"); } };
  const id = await ensureProjectHub(channel as never, { ...projectFixture, hubPanelMessageId: "live-hub" }, connectedHealthFixture);
  assert.equal(id, "live-hub");
  assert.equal(unpinned, true);
});

test("pinned hub guide is created separately from the live hub", async () => {
  let pinned = false;
  let sentPayload: { components?: unknown[] } | undefined;
  const created = { id: "guide-message", pin: async () => { pinned = true; } };
  const channel = { messages: { fetch: async () => null }, send: async (payload: { components?: unknown[] }) => { sentPayload = payload; return created; } };
  const id = await ensureProjectHubGuide(channel as never, projectFixture, "live-hub");
  assert.equal(id, "guide-message");
  assert.equal(pinned, true);
  assert.equal(sentPayload?.components?.length ?? 0, 0);
});
