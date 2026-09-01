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
import { projectHubActionCopy, projectHubMessage } from "../src/services/project-experience/project-hub.js";
import type { StoredProject } from "../src/services/projects.js";

const projectFixture: StoredProject = {
  id: "abc123",
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
  notionUrl: "https://www.notion.so/0123456789abcdef0123456789abcdef",
  figmaUrl: "https://www.figma.com/design/example/file",
};

const connectedHealthFixture: ProjectHealth = {
  github: "connected",
  review: "connected",
  calendar: "connected",
  scrum: "connected",
  notion: "connected",
  figma: "connected",
};

test("project hub custom ids round-trip", () => {
  const id = buildProjectHubId("calendar", "abc123");
  assert.equal(id, "project_hub:calendar:abc123");
  assert.deepEqual(parseProjectHubId(id), { action: "calendar", projectId: "abc123" });
  assert.equal(parseProjectHubId("calendar:add:abc123"), null);
});

test("project health uses short user-facing states", () => {
  const lines = projectHealthLines({
    github: "connected",
    review: "needs_admin",
    calendar: "needs_setup",
    scrum: "connected",
    notion: "connected",
    figma: "needs_setup",
  });

  assert.ok(lines.some((line) => line.includes("Code Review") && line.includes("관리자 설정 필요")));
  assert.ok(lines.some((line) => line.includes("Google Calendar") && line.includes("설정 필요")));
  assert.ok(lines.every((line) => !line.includes("403")));
});

test("stored project health uses one shared diagnostic rule", () => {
  const healthy = storedProjectHealth({
    ...projectFixture,
    frontendHookId: 1,
    backendHookId: 2,
    calendarId: "calendar1",
    scrumChannelId: "scrum1",
    scrumPanelMessageId: "scrum-panel1",
  });
  assert.deepEqual(healthy, {
    github: "connected",
    review: "checking",
    calendar: "connected",
    scrum: "connected",
    notion: "connected",
    figma: "connected",
  });

  const incomplete = storedProjectHealth({
    ...projectFixture,
    notionUrl: undefined,
    figmaUrl: undefined,
  });
  assert.equal(incomplete.github, "repair");
  assert.equal(incomplete.calendar, "needs_setup");
  assert.equal(incomplete.scrum, "repair");
  assert.equal(incomplete.notion, "needs_setup");
  assert.equal(incomplete.figma, "needs_setup");
});

test("project health issues stay actionable and hide raw api details", () => {
  const issues = projectHealthIssues({
    github: "repair",
    review: "needs_admin",
    calendar: "needs_setup",
    scrum: "repair",
    notion: "needs_setup",
    figma: "connected",
  });
  assert.ok(issues.some((line) => line.includes("GitHub") && line.includes("복구")));
  assert.ok(issues.some((line) => line.includes("Code Review") && line.includes("관리자")));
  assert.ok(issues.every((line) => !/403|HTTP|token|PAT/i.test(line)));
});

test("project hub exposes the five primary member actions", () => {
  const payload = projectHubMessage(projectFixture, connectedHealthFixture);
  const ids = payload.components.flatMap((row) =>
    row.components.map((component) => component.data.custom_id),
  );

  assert.ok(ids.includes("project_hub:calendar:abc123"));
  assert.ok(ids.includes("project_hub:scrum:abc123"));
  assert.ok(ids.includes("project_hub:github:abc123"));
  assert.ok(ids.includes("project_hub:review:abc123"));
  assert.ok(ids.includes("project_hub:refresh:abc123"));
  assert.ok(ids.includes("project_hub:admin:abc123"));
});

test("every project hub action has user-facing copy", () => {
  for (const action of ["calendar", "scrum", "github", "review", "refresh", "admin"] as const) {
    assert.ok(projectHubActionCopy(action).trim().length > 0);
  }
});
