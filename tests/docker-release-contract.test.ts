import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startWebControlPlaneServer } from "../src/web-control-plane/server.js";

test("health endpoint reports process health without requiring external credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "npc-health-"));
  await mkdir(join(root, "web"), { recursive: true });
  const server = await startWebControlPlaneServer({
    host: "127.0.0.1",
    port: 0,
    token: "local-test-token",
    modelRoot: join(root, "model"),
    harnessRoot: join(root, "runs"),
    webRoot: join(root, "web"),
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("release distribution files declare a non-root image and persistent data volume", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8").catch(() => "");
  const compose = await readFile("docker-compose.example.yml", "utf8").catch(() => "");
  assert.match(dockerfile, /USER npc/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /npm ci --include=dev --ignore-scripts/);
  assert.match(dockerfile, /npm --prefix user-ui ci --include=dev --ignore-scripts/);
  assert.match(dockerfile, /COPY user-ui\/\.figma\/make\/site\.json/);
  assert.match(compose, /\/app\/data/);
});
