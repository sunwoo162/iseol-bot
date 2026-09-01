import assert from "node:assert/strict";
import test from "node:test";
import { projectCommand } from "../src/commands/project.js";
import { parseProjectSetupFields } from "../src/services/project-experience/project-setup.js";
import { normalizeRepositoryPair } from "../src/services/projects.js";

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
