import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package exposes production doctor and command registration for docker users", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["doctor:prod"], "node dist/setup/doctor-cli.js");
  assert.equal(pkg.scripts?.["register:prod"], "node --use-system-ca dist/register-commands.js");
});

test("readme has a docker-only five minute path with doctor before startup", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /5분.*시작|빠른 시작.*5분/);
  assert.match(readme, /docker compose build/);
  assert.match(readme, /docker compose run --rm iseol npm run doctor:prod/);
  assert.match(readme, /docker compose run --rm iseol npm run register:prod/);
  assert.match(readme, /docker compose up -d/);
  assert.match(readme, /Google Calendar 연결/);
});

test("environment template documents docker port and one-click google oauth server setup", async () => {
  const env = await readFile(".env.example", "utf8");
  assert.match(env, /ISEOL_PORT=8787/);
  assert.match(env, /GOOGLE_CLIENT_ID=/);
  assert.match(env, /GOOGLE_CLIENT_SECRET=/);
  assert.match(env, /PUBLIC_BASE_URL=/);
  assert.match(env, /GOOGLE_REFRESH_TOKEN=/);
});
