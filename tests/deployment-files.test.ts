import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function text(path: string): Promise<string> {
  return readFile(path, "utf8");
}

test("docker image builds TypeScript on Node 22 and runs compiled production output", async () => {
  const dockerfile = await text("Dockerfile");
  assert.match(dockerfile, /FROM node:22/);
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /dist\/index\.js/);
  assert.match(dockerfile, /EXPOSE 8787/);
});

test("compose persists runtime data and exposes only the integration http port", async () => {
  const compose = await text("docker-compose.yml");
  assert.match(compose, /env_file:\s*\n\s*- \.env/);
  assert.match(compose, /8787:8787|\$\{ISEOL_PORT:-8787\}:8787/);
  assert.match(compose, /\/app\/data/);
  assert.match(compose, /restart: unless-stopped/);
});

test("docker context never bakes secrets or runtime state into the image", async () => {
  const ignore = await text(".dockerignore");
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^data\/?$/m);
  assert.match(ignore, /^node_modules\/?$/m);
  assert.match(ignore, /^\.git\/?$/m);
});
