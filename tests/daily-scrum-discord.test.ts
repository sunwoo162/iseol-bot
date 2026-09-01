import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectScrumId,
  parseProjectScrumId,
  scrumPanelMessage,
} from "../src/services/daily-scrum-discord.js";
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
  scrumChannelId: "scrum1",
};

test("project scrum custom ids round-trip", () => {
  const id = buildProjectScrumId("write", "p1");
  assert.equal(id, "project_scrum:write:p1");
  assert.deepEqual(parseProjectScrumId(id), { action: "write", projectId: "p1" });
  assert.deepEqual(parseProjectScrumId("project_scrum:carry:p1"), { action: "carry", projectId: "p1" });
  assert.deepEqual(parseProjectScrumId("project_scrum:recent:p1"), { action: "recent", projectId: "p1" });
  assert.equal(parseProjectScrumId("project_scrum:delete:p1"), null);
});

test("scrum panel exposes the three member actions", () => {
  const payload = scrumPanelMessage(projectFixture);
  const ids = payload.components.flatMap((row) =>
    row.components.map((item) => item.data.custom_id),
  );

  assert.deepEqual(ids, [
    "project_scrum:write:p1",
    "project_scrum:carry:p1",
    "project_scrum:recent:p1",
  ]);
  assert.match(payload.embeds[0]?.data.title ?? "", /데일리 스크럼/);
});
