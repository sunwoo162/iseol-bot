import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

test("release readiness command and CI workflow exist", async () => {
  assert.equal(existsSync("scripts/check-release-readiness.mjs"), true);
  assert.equal(existsSync(".github/workflows/ci.yml"), true);
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(workflow, /runs-on:\s*windows-latest/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm --prefix user-ui ci/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run user-ui:build/);
  assert.match(workflow, /check-release-readiness/);
  assert.match(workflow, /lfs:\s*true/);
  assert.match(workflow, /DISCORD_TOKEN:\s*ci-discord-token/);
  assert.match(workflow, /DISCORD_CLIENT_ID:\s*ci-discord-client/);
  assert.match(workflow, /GITHUB_TOKEN:\s*ci-github-token/);
  assert.match(workflow, /FIGMA_TOKEN:\s*ci-figma-token/);
  assert.match(workflow, /NOTION_TOKEN:\s*ci-notion-token/);
});

test("release readiness script checks required artifacts and forbidden tracked secrets", async () => {
  const script = await readFile("scripts/check-release-readiness.mjs", "utf8");
  assert.match(script, /LICENSE/);
  assert.match(script, /AGPL-3\.0/);
  assert.match(script, /DISCORD_TOKEN|GITHUB_TOKEN/);
  assert.match(script, /Broadcast Room|방송실/);
});
