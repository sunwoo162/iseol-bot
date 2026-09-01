import assert from "node:assert/strict";
import test from "node:test";
import { projectExperienceNeeds } from "../src/services/project-experience/project-migration.js";
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
