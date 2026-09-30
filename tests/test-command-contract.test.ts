import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("npm test runs the full suite with deterministic single-file concurrency", async () => {
  const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts?: { test?: string };
  };

  assert.match(packageJson.scripts?.test ?? "", /--test-concurrency=1/);
});
