import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { PrototypeCandidate } from "../src/project-model/contracts.js";
import { savePrototypeCandidate } from "../src/project-model/prototype-store.js";
import {
  resolveWebControlPlaneConfig,
  startWebControlPlaneServer,
} from "../src/web-control-plane/server.js";

function candidate(): PrototypeCandidate {
  return {
    version: 1,
    id: "prototype-001",
    title: "Study Race",
    concept: "Compete on study time",
    repository: { url: "https://github.com/example/repo", branch: "main", commitSha: "abc123" },
    deployment: { url: "https://study.example.com" },
    runIds: [],
    status: "candidate",
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  };
}

test("control plane config defaults to loopback and rejects unauthenticated public bind", () => {
  const local = resolveWebControlPlaneConfig({});
  assert.equal(local.host, "127.0.0.1");
  assert.equal(local.port > 0, true);
  assert.throws(
    () => resolveWebControlPlaneConfig({ ISEOL_WEB_HOST: "0.0.0.0" }),
    /ISEOL_WEB_TOKEN/,
  );
});

test("control plane config accepts authenticated public bind", () => {
  const config = resolveWebControlPlaneConfig({
    ISEOL_WEB_HOST: "0.0.0.0",
    ISEOL_WEB_PORT: "8899",
    ISEOL_WEB_TOKEN: "secret-token",
    ISEOL_MODEL_ROOT: "C:/iseol/model",
    ISEOL_RUN_ROOT: "C:/iseol/runs",
  });
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.port, 8899);
  assert.equal(config.token, "secret-token");
  assert.equal(config.modelRoot, "C:/iseol/model");
  assert.equal(config.harnessRoot, "C:/iseol/runs");
});

async function startFixture() {
  const root = await mkdtemp(join(tmpdir(), "iseol-web-server-"));
  const modelRoot = join(root, "model");
  const harnessRoot = join(root, "runs");
  const webRoot = join(root, "web");
  await mkdir(webRoot, { recursive: true });
  await writeFile(join(webRoot, "index.html"), "<h1>Iseol</h1>", "utf8");
  await writeFile(join(webRoot, "app.js"), "console.log('iseol')", "utf8");
  await savePrototypeCandidate(modelRoot, candidate());
  const server = await startWebControlPlaneServer({
    host: "127.0.0.1",
    port: 0,
    token: "secret-token",
    modelRoot,
    harnessRoot,
    webRoot,
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

test("server delegates API requests and serves static content types", async () => {
  const { server, baseUrl } = await startFixture();
  try {
    const idea = await fetch(`${baseUrl}/api/idea-lab`);
    assert.equal(idea.status, 200);
    assert.equal((await idea.json() as any).prototypes[0].id, "prototype-001");

    const html = await fetch(`${baseUrl}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(await html.text(), "<h1>Iseol</h1>");

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});

test("server rejects invalid and oversized JSON mutation bodies", async () => {
  const { server, baseUrl } = await startFixture();
  try {
    const invalid = await fetch(`${baseUrl}/api/prototypes/prototype-001/promote`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: "{broken",
    });
    assert.equal(invalid.status, 400);

    const oversized = await fetch(`${baseUrl}/api/prototypes/prototype-001/promote`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(70_000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
