import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEnsuredProjectExperience,
  planProjectExperienceMigration,
  projectExperienceNeeds,
} from "../src/services/project-experience/project-migration.js";
import { storedProjectHealth } from "../src/services/project-experience/project-health.js";
import type { StoredProject } from "../src/services/projects.js";

const legacyProject: StoredProject = {
  id: "legacy1",
  name: "Legacy",
  guildId: "guild1",
  categoryId: "category1",
  organization: "example",
  frontend: {
    owner: "example",
    repo: "frontend",
    url: "https://github.com/example/frontend",
  },
  backend: {
    owner: "example",
    repo: "backend",
    url: "https://github.com/example/backend",
  },
};

test("legacy project without hub and scrum is marked for both ensures", () => {
  assert.deepEqual(projectExperienceNeeds(legacyProject), { hub: true, scrum: true });
});

test("fully migrated project needs no duplicate resources", () => {
  assert.deepEqual(projectExperienceNeeds({
    ...legacyProject,
    hubPanelMessageId: "hub1",
    scrumChannelId: "scrum1",
  }), { hub: false, scrum: false });
});

test("startup migration keeps duplicate stored records and reuses one category ensure", () => {
  const duplicate: StoredProject = {
    ...legacyProject,
    id: "legacy2",
    name: "Legacy duplicate",
  };

  const plan = planProjectExperienceMigration([legacyProject, duplicate]);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((item) => item.mode), ["ensure", "reuse"]);
  assert.deepEqual(plan.map((item) => item.project.id), ["legacy1", "legacy2"]);
  assert.equal(plan[0]?.key, plan[1]?.key);
});

test("post-ensure snapshot refreshes health from newly stored ids", () => {
  const refreshed = applyEnsuredProjectExperience(legacyProject, {
    hubPanelMessageId: "hub1",
    scrumChannelId: "scrum1",
    scrumPanelMessageId: "scrum-panel1",
  });

  assert.equal(refreshed.hubPanelMessageId, "hub1");
  assert.equal(refreshed.scrumChannelId, "scrum1");
  assert.equal(refreshed.scrumPanelMessageId, "scrum-panel1");
  assert.equal(storedProjectHealth(refreshed).scrum, "connected");
});
