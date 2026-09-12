import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatGptBrowserDriver } from "../src/chatgpt-web/production-browser-adapter.js";
import { startIseolRuntimeServices } from "../src/runtime/iseol-runtime-services.js";

function browserDriver(onDispose: () => void = () => undefined): ChatGptBrowserDriver {
  return {
    openOrResumeConversation: async () => ({ conversationRef: "conversation-1" }),
    submitPrompt: async () => ({ conversationRef: "conversation-1" }),
    readStructuredResult: async () => [],
    closeConversation: async () => undefined,
    dispose: async () => onDispose(),
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  const roots = {
    iseolRoot: "C:/iseol",
    modelRoot: "C:/iseol-model",
    runRoot: "C:/iseol-runs",
    webRoot: "C:/iseol-web",
    browserProfileRoot: "C:/chatgpt-profile",
  };
  return {
    env: {},
    roots,
    webConfig: {
      host: "127.0.0.1", port: 0, token: "",
      modelRoot: roots.modelRoot, harnessRoot: roots.runRoot, webRoot: roots.webRoot,
    },
    desktopConfig: {
      enabled: true, host: "127.0.0.1", port: 0,
      stateRoot: "C:/desktop-state", token: "desktop-token",
    },
    ideaLabConfig: { enabled: false },
    deps: {
      resolveBrowser: async () => browserDriver(),
      startDesktop: async () => ({
        transport: { sendTask() {}, awaitResult: async () => { throw new Error("unused"); } },
        close: async () => { events.push("desktop"); },
      }),
      startWeb: async (options: any) => {
        events.push(`web:${options.ideaLabRuntime?.state ?? "none"}`);
        return { close: (done?: (error?: Error) => void) => { events.push("web-close"); done?.(); } };
      },
    },
    ...overrides,
    events,
  } as any;
}
function liveConfig() {
  return {
    enabled: true as const,
    repositoryRoot: "C:/sandbox/source",
    repositoryUrl: "https://github.com/example/idea-lab.git",
    baseRef: "main",
    sandboxRoot: "C:/sandbox",
    agentId: "agent-live",
    testExecutable: "npm.cmd",
    testArgs: ["test"],
    testTimeoutMs: 30_000,
  };
}

test("shares one browser across bridge and Idea Lab and disposes it exactly once", async () => {
  let browserCreates = 0;
  let browserDisposes = 0;
  let bridgeDriver: unknown;
  let providerDriver: unknown;
  const shared = browserDriver(() => { browserDisposes += 1; });
  const value = fixture({ env: { ISEOL_CHATGPT_WEB_ENABLED: "true" }, ideaLabConfig: liveConfig() });
  value.deps.resolveBrowser = async () => { browserCreates += 1; return shared; };
  value.deps.resolveDeploy = async () => ({});
  value.deps.createBridge = async (_config: unknown, driver: unknown) => {
    bridgeDriver = driver;
    return { enabled: true, dispose: async () => undefined };
  };
  value.deps.createProposalProvider = (driver: unknown) => { providerDriver = driver; return {}; };
  value.deps.createProductionDriver = () => ({});
  value.deps.createRuntime = () => ({ recover: async () => undefined, dispose: async () => undefined });

  const services = await startIseolRuntimeServices(value);
  assert.equal(browserCreates, 1);
  assert.equal(bridgeDriver, shared);
  assert.equal(providerDriver, shared);
  await services.dispose();
  await services.dispose();
  assert.equal(browserDisposes, 1);
});

test("Idea-Lab-only runtime resolves the browser once even when standalone bridge is disabled", async () => {
  let browserCreates = 0;
  const value = fixture({ env: { ISEOL_CHATGPT_WEB_ENABLED: "false" }, ideaLabConfig: liveConfig() });
  value.deps.resolveBrowser = async () => { browserCreates += 1; return browserDriver(); };
  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => ({});
  value.deps.createRuntime = () => ({ recover: async () => undefined, dispose: async () => undefined });

  const services = await startIseolRuntimeServices(value);
  assert.equal(services.ideaLabCapability.state, "ready");
  assert.equal(browserCreates, 1);
  await services.dispose();
});
for (const [name, configure] of [
  ["Desktop Core", (value: any) => { value.desktopConfig = { ...value.desktopConfig, enabled: false }; }],
  ["browser", (value: any) => { value.deps.resolveBrowser = async () => null; }],
  ["Vercel adapter", (value: any) => { value.deps.resolveDeploy = async () => null; }],
] as const) {
  test(`missing ${name} blocks live Idea Lab before driver construction or recovery`, async () => {
    let constructed = 0;
    let recovered = 0;
    const value = fixture({ ideaLabConfig: liveConfig() });
    value.deps.resolveDeploy = async () => ({});
    value.deps.createProductionDriver = () => { constructed += 1; return {}; };
    value.deps.createRuntime = () => ({
      recover: async () => { recovered += 1; },
      dispose: async () => undefined,
    });
    configure(value);

    const services = await startIseolRuntimeServices(value);
    assert.equal(services.ideaLabCapability.state, "blocked");
    assert.equal(constructed, 0);
    assert.equal(recovered, 0);
    await services.dispose();
  });
}

test("production driver receives the shared Desktop transport and a real sandbox adapter", async () => {
  let productionInput: any;
  const transport = { sendTask() {}, awaitResult: async () => { throw new Error("unused"); } };
  const value = fixture({ ideaLabConfig: liveConfig() });
  value.deps.startDesktop = async () => ({ transport, close: async () => undefined });
  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = (input: any) => { productionInput = input; return {}; };
  value.deps.createRuntime = () => ({ recover: async () => undefined, dispose: async () => undefined });

  const services = await startIseolRuntimeServices(value);
  assert.equal(productionInput.desktopTransport, transport);
  assert.equal(typeof productionInput.sandboxAdapter?.allocate, "function");
  assert.equal(typeof productionInput.sandboxAdapter?.inspect, "function");
  await services.dispose();
});

test("recovery finishes before Web sees ready and shutdown follows single-owner order", async () => {
  const order: string[] = [];
  const value = fixture({ ideaLabConfig: liveConfig() });
  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => ({});
  value.deps.createRuntime = () => ({
    recover: async () => { order.push("recover"); },
    dispose: async () => { order.push("runtime"); },
  });
  value.deps.startDesktop = async () => ({
    transport: { sendTask() {}, awaitResult: async () => { throw new Error("unused"); } },
    close: async () => { order.push("desktop"); },
  });
  value.deps.startWeb = async (options: any) => {
    order.push(`web:${options.ideaLabRuntime.state}`);
    return { close: (done?: (error?: Error) => void) => { order.push("web-close"); done?.(); } };
  };
  value.deps.resolveBrowser = async () => browserDriver(() => { order.push("browser"); });

  const services = await startIseolRuntimeServices(value);
  assert.deepEqual(order.slice(0, 2), ["recover", "web:ready"]);
  await services.dispose();
  assert.deepEqual(order.slice(-4), ["web-close", "runtime", "desktop", "browser"]);
});
test("Discord entrypoint retains the composed Iseol runtime lifecycle handle", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /let iseolRuntimeServices/);
  assert.match(source, /iseolRuntimeServices\s*=\s*services/);
  assert.equal(source.includes("detached startup replaced by composition"), false);
});

test("startup failure disposes already-created resources and preserves the original error", async () => {
  const order: string[] = [];
  const value = fixture({ env: { ISEOL_CHATGPT_WEB_ENABLED: "true" }, ideaLabConfig: liveConfig() });
  value.deps.startDesktop = async () => ({
    transport: { sendTask() {}, awaitResult: async () => { throw new Error("unused"); } },
    close: async () => { order.push("desktop"); },
  });
  value.deps.resolveBrowser = async () => browserDriver(() => { order.push("browser"); });
  value.deps.createBridge = async () => ({ enabled: true, dispose: async () => { order.push("bridge"); } });
  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => ({});
  value.deps.createRuntime = () => ({
    recover: async () => { order.push("recover"); },
    dispose: async () => { order.push("runtime"); },
  });
  value.deps.startWeb = async () => { throw new Error("web startup failed"); };

  await assert.rejects(startIseolRuntimeServices(value), /web startup failed/);
  assert.deepEqual(order, ["recover", "bridge", "runtime", "desktop", "browser"]);
});
test("Discord entrypoint disposes the composed runtime on termination signals", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /process\.once\("SIGINT"/);
  assert.match(source, /process\.once\("SIGTERM"/);
  assert.match(source, /let iseolRuntimeStartup/);
  assert.match(source, /await iseolRuntimeStartup/);
  assert.match(source, /await services\?\.dispose\(\)/);
});