import assert from "node:assert/strict";
import test from "node:test";
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
