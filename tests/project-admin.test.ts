import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectAdminId,
  parseProjectAdminId,
  projectAdminPanel,
} from "../src/services/project-experience/project-admin.js";
import type { ProjectHealth } from "../src/services/project-experience/project-health.js";
import type { StoredProject } from "../src/services/projects.js";

const project: StoredProject = {
  id: "p1",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "category1",
  organization: "rain-gj",
  frontend: { owner: "rain-gj", repo: "frontend", url: "https://github.com/rain-gj/frontend" },
  backend: { owner: "rain-gj", repo: "backend", url: "https://github.com/rain-gj/backend" },
};

const health: ProjectHealth = {
  github: "repair",
  review: "needs_admin",
  calendar: "needs_setup",
  scrum: "connected",
  notion: "needs_setup",
  figma: "connected",
};

test("project admin custom ids round-trip", () => {
  const id = buildProjectAdminId("repair", "p1");
  assert.equal(id, "project_admin:repair:p1");
  assert.deepEqual(parseProjectAdminId(id), { action: "repair", projectId: "p1" });
  assert.equal(parseProjectAdminId("project_admin:delete:p1"), null);
});

test("project admin panel exposes safe diagnostics actions only", () => {
  const payload = projectAdminPanel(project, health);
  const ids = payload.components.flatMap((row) =>
    row.components
      .map((component) => component.data.custom_id)
      .filter((value): value is string => Boolean(value)),
  );

  assert.deepEqual(ids, [
    "project_admin:settings:p1",
    "project_admin:repair:p1",
    "project_admin:refresh:p1",
  ]);
  assert.ok(ids.every((id) => !id.includes("delete")));
  assert.match(payload.embeds[0]?.data.title ?? "", /프로젝트 관리/);
  assert.match(payload.embeds[0]?.data.description ?? "", /Code Review/);
});
