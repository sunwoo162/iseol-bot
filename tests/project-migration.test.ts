import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEnsuredProjectExperience,
  planProjectExperienceMigration,
  projectExperienceNeeds,
  resolveProjectCategoryId,
} from "../src/services/project-experience/project-migration.js";
import { storedProjectHealth } from "../src/services/project-experience/project-health.js";
import type { StoredProject } from "../src/services/projects.js";

const legacyProject: StoredProject = {
  id: "legacy1",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "stale-category",
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
  const duplicate = { ...legacyProject, id: "legacy2" };
  assert.deepEqual(
    planProjectExperienceMigration([legacyProject, duplicate]).map((item) => item.mode),
    ["ensure", "reuse"],
  );
});

test("post-ensure snapshot refreshes health from newly stored ids", () => {
  const refreshed = applyEnsuredProjectExperience(legacyProject, {
    hubPanelMessageId: "hub1",
    scrumChannelId: "scrum1",
    scrumPanelMessageId: "panel1",
  });
  const health = storedProjectHealth(refreshed);
  assert.equal(health.scrum, "connected");
  assert.equal(refreshed.hubPanelMessageId, "hub1");
});

test("stale category reconnects only when the exact project category is unique", () => {
  assert.equal(resolveProjectCategoryId(legacyProject, [
    { id: "real-category", name: "📁 Rain GJ" },
  ]), "real-category");

  assert.equal(resolveProjectCategoryId(legacyProject, [
    { id: "category-a", name: "📁 Rain GJ" },
    { id: "category-b", name: "📁 Rain GJ" },
  ]), null);
});

test("resolved stale records deduplicate by the recovered category", () => {
  const recovered = [
    { ...legacyProject, id: "a", categoryId: "real-category" },
    { ...legacyProject, id: "b", categoryId: "real-category" },
    { ...legacyProject, id: "c", categoryId: "real-category" },
  ];

  assert.deepEqual(
    planProjectExperienceMigration(recovered).map((item) => item.mode),
    ["ensure", "reuse", "reuse"],
  );
});

test("an already-valid category record becomes canonical before recovered duplicates", () => {
  const recoveredA = { ...legacyProject, id: "a", categoryId: "real-category" };
  const recoveredB = { ...legacyProject, id: "b", categoryId: "real-category" };
  const valid = { ...legacyProject, id: "valid", categoryId: "real-category" };

  const plan = planProjectExperienceMigration(
    [recoveredA, recoveredB, valid],
    new Set([valid.id]),
  );

  assert.deepEqual(plan.map((item) => item.project.id), ["valid", "a", "b"]);
  assert.deepEqual(plan.map((item) => item.mode), ["ensure", "reuse", "reuse"]);
});
