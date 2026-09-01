import assert from "node:assert/strict";
import test from "node:test";
import { projectCommand } from "../src/commands/project.js";
import {
  parseProjectSetupFields,
  projectSetupPinnedGuides,
} from "../src/services/project-experience/project-setup.js";
import { normalizeRepositoryPair, type StoredProject } from "../src/services/projects.js";

const frontend = {
  owner: "Rain-GJ",
  repo: "Front",
  url: "https://github.com/Rain-GJ/Front",
};
const backend = {
  owner: "rain-gj",
  repo: "Back",
  url: "https://github.com/rain-gj/Back",
};

const project: StoredProject = {
  id: "p1",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "category1",
  organization: "rain-gj",
  frontend,
  backend,
  notionUrl: "https://www.notion.so/rain",
  figmaUrl: "https://www.figma.com/design/rain",
};

test("repository pair key is case-insensitive and order-independent", () => {
  assert.equal(
    normalizeRepositoryPair(frontend, backend),
    normalizeRepositoryPair(backend, frontend),
  );
});

test("project setup accepts empty notion and figma", () => {
  const parsed = parseProjectSetupFields({
    name: "Rain GJ",
    frontend: "https://github.com/rain-gj/rain-gj-frontend",
    backend: "https://github.com/rain-gj/rain-gj-backend",
    notion: "",
    figma: "",
  });

  assert.equal(parsed.name, "Rain GJ");
  assert.equal(parsed.notion, null);
  assert.equal(parsed.figma, null);
  assert.equal(parsed.frontend.owner, "rain-gj");
  assert.equal(parsed.backend.owner, "rain-gj");
});

test("project setup rejects repositories from different organizations", () => {
  assert.throws(() => parseProjectSetupFields({
    name: "Mixed",
    frontend: "https://github.com/org-a/front",
    backend: "https://github.com/org-b/back",
    notion: "",
    figma: "",
  }), /같은 GitHub Organization/);
});

test("project create opens a modal instead of exposing five command options", () => {
  const json = projectCommand.toJSON();
  const create = json.options?.find((option) => option.name === "create");
  assert.deepEqual(create?.options ?? [], []);
});

test("new projects start with navigation-only pinned guides", () => {
  const guides = projectSetupPinnedGuides(project, "https://discord.com/channels/g/c/m");
  for (const payload of [guides.scrum, guides.calendar, guides.notion, guides.figma]) {
    assert.equal(payload.components.length, 0);
  }
  assert.match(guides.scrum.embeds[0]?.data.description ?? "", /프로젝트.*스크럼|스크럼/);
  assert.match(guides.calendar.embeds[0]?.data.description ?? "", /작업 만들기/);
});
