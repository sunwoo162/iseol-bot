import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDesktopAgentCoreConfig,
  startDesktopAgentCoreService,
} from "../src/desktop-agent/core-service.js";
import {
  resolveDesktopAgentClientConfig,
  runPersistentDesktopAgent,
} from "../src/desktop-agent/agent-service.js";

test("Core desktop service is opt-in and loopback-only", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "iseol-desktop-core-"));
  const disabled = resolveDesktopAgentCoreConfig({}, cwd);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.host, "127.0.0.1");
  assert.equal(disabled.port, 8791);

  assert.throws(
    () => resolveDesktopAgentCoreConfig({ ISEOL_DESKTOP_AGENT_HOST: "0.0.0.0" }, cwd),
    /token.*required/i,
  );
  assert.throws(
    () => resolveDesktopAgentCoreConfig({
      ISEOL_DESKTOP_AGENT_HOST: "0.0.0.0",
      ISEOL_DESKTOP_AGENT_TOKEN: "secret",
    }, cwd),
    /loopback.*tls reverse proxy/i,
  );
});

test("enabled Core desktop service starts an authenticated loopback transport", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "iseol-desktop-core-live-"));
  const config = resolveDesktopAgentCoreConfig({
    ISEOL_DESKTOP_AGENT_TOKEN: "secret-token",
    ISEOL_DESKTOP_AGENT_PORT: "0",
  }, cwd, { allowEphemeralPort: true });
  const service = await startDesktopAgentCoreService(config);
  try {
    assert.equal(service.config.enabled, true);
    assert.match(service.url, /^ws:\/\/127\.0\.0\.1:/);
  } finally {
    await service.close();
  }
});

test("Agent client config requires secure public transport and explicit roots", () => {
  assert.throws(() => resolveDesktopAgentClientConfig({}), /url.*required/i);
  assert.throws(() => resolveDesktopAgentClientConfig({
    ISEOL_DESKTOP_AGENT_URL: "ws://example.com/desktop",
    ISEOL_DESKTOP_AGENT_TOKEN: "secret",
    ISEOL_DESKTOP_AGENT_ID: "agent-001",
    ISEOL_DESKTOP_AGENT_WORKSPACE_ROOTS: "C:\\Users\\user\\Documents",
  }), /wss.*public/i);
  const config = resolveDesktopAgentClientConfig({
    ISEOL_DESKTOP_AGENT_URL: "wss://iseol.example.com/desktop",
    ISEOL_DESKTOP_AGENT_TOKEN: "secret",
    ISEOL_DESKTOP_AGENT_ID: "agent-001",
    ISEOL_DESKTOP_AGENT_WORKSPACE_ROOTS: "C:\\A;C:\\B",
  });
  assert.deepEqual(config.workspaceRoots, ["C:\\A", "C:\\B"]);
});

test("persistent Agent reconnect uses bounded exponential backoff", async () => {
  const abort = new AbortController();
  const delays: number[] = [];
  let attempts = 0;
  await runPersistentDesktopAgent({
    url: "ws://127.0.0.1:8791",
    token: "secret",
    agentId: "agent-001",
    workspaceRoots: [process.cwd()],
    heartbeatIntervalMs: 1_000,
    reconnectBaseMs: 10,
    reconnectMaxMs: 25,
  }, {
    signal: abort.signal,
    connect: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("offline");
      abort.abort();
      return { close: async () => undefined, closed: Promise.resolve() };
    },
    sleep: async (ms) => { delays.push(ms); },
    random: () => 0,
  });
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("production entrypoints wire Core startup and Desktop Agent scripts", async () => {
  const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(index, /startDesktopAgentCoreService/);
  assert.match(index, /resolveDesktopAgentCoreConfig/);
  assert.equal(pkg.scripts["desktop:agent"], "tsx src/desktop-agent/main.ts");
  assert.equal(pkg.scripts["desktop:agent:start"], "node dist/desktop-agent/main.js");
});
