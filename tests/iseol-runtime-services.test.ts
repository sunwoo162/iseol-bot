import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import type { ChatGptBrowserDriver } from "../src/chatgpt-web/production-browser-adapter.js";
import { shouldAutoRecoverProjectRun, startIseolRuntimeServices } from "../src/runtime/iseol-runtime-services.js";
import { saveHarnessRun } from "../src/harness/run-store.js";

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
    projectModelRoot: "C:/project-model",
    projectRunRoot: "C:/project-runs",
    projectWebWorkerRoot: "C:/project-workers",
    projectDesktopStateRoot: "C:/project-desktop-state",
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
    agentReadyTimeoutMs: 0,
    deps: {
      resolveBrowser: async () => browserDriver(),
      startDesktop: async () => ({
        transport: { isAgentConnected: () => true, sendTask() {}, awaitResult: async () => { throw new Error("unused"); } },
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

test("Project Workspace recovery does not auto-retry FAILED_RETRYABLE runs", () => {
  assert.equal(shouldAutoRecoverProjectRun("READY"), true);
  assert.equal(shouldAutoRecoverProjectRun("RUNNING"), true);
  assert.equal(shouldAutoRecoverProjectRun("FAILED_RETRYABLE"), false);
  assert.equal(shouldAutoRecoverProjectRun("FAILED_FINAL"), false);
});

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

test("Project Workspace runs use the configured repository policy root for global Harness policy", async () => {
  let webOptions: any;
  const value = fixture({
    env: { ISEOL_PROJECT_RUNTIME_ENABLED: "true", ISEOL_PROJECT_AGENT_ID: "agent-project" },
    ideaLabConfig: liveConfig(),
  });
  value.deps.resolveBrowser = async () => browserDriver();
  value.deps.startWeb = async (options: any) => {
    webOptions = options;
    return { close: (done?: (error?: Error) => void) => done?.() };
  };

  const services = await startIseolRuntimeServices(value);
  assert.equal(webOptions.iseolRoot, "C:/sandbox/source");
  assert.equal(webOptions.policyRoot, "C:/sandbox/source");
  await services.dispose();
});

test("Project Workspace executor uses the shared Desktop registry and isolated job state", async () => {
  let executorInput: any;
  const value = fixture({
    env: { ISEOL_PROJECT_RUNTIME_ENABLED: "true", ISEOL_PROJECT_AGENT_ID: "agent-project" },
  });
  value.deps.createProjectExecutor = (input: any) => {
    executorInput = input;
    return {};
  };
  value.deps.startWeb = async (options: any) => ({
    close: (done?: (error?: Error) => void) => done?.(),
    options,
  });

  const services = await startIseolRuntimeServices(value);
  assert.equal(executorInput.registryRoot, "C:/desktop-state");
  assert.equal(executorInput.desktopStateRoot, resolve("C:/project-desktop-state"));
  await services.dispose();
});

test("Project Workspace runtime registers the shared AI/Desktop executor when explicitly enabled", async () => {
  let capability: any;
  const value = fixture({ env: {
    ISEOL_PROJECT_RUNTIME_ENABLED: "true",
    ISEOL_PROJECT_AGENT_ID: "agent-project",
  } });
  value.deps.resolveBrowser = async () => browserDriver();
  value.deps.startDesktop = async () => ({
    transport: { isAgentConnected: (agentId: string) => agentId === "agent-project", sendTask() {}, awaitResult: async () => { throw new Error("unused"); } },
    close: async () => undefined,
  });
  value.deps.startWeb = async (options: any) => {
    capability = options.ideaLabRuntime;
    return { close: (done?: (error?: Error) => void) => done?.() };
  };
  const services = await startIseolRuntimeServices(value);
  assert.equal(typeof capability.enqueueProjectRun, "function");
  assert.equal(await capability.enqueueProjectRun("missing-project-run"), "not-configured");
  await services.dispose();
});

test("Project Workspace runtime exposes isolated roots to the web control plane", async () => {
  let webOptions: any;
  const value = fixture({
    env: { ISEOL_PROJECT_RUNTIME_ENABLED: "true", ISEOL_PROJECT_AGENT_ID: "agent-project" },
    roots: {
      iseolRoot: "C:/iseol",
      modelRoot: "C:/iseol-model",
      runRoot: "C:/iseol-runs",
      webRoot: "C:/iseol-web",
      webWorkerRoot: "C:/idea-lab-workers",
      browserProfileRoot: "C:/chatgpt-profile",
      projectModelRoot: "C:/project-model",
      projectRunRoot: "C:/project-runs",
      projectWebWorkerRoot: "C:/project-workers",
      projectDesktopStateRoot: "C:/project-desktop-state",
    },
  });
  value.deps.startWeb = async (options: any) => {
    webOptions = options;
    return { close: (done?: (error?: Error) => void) => done?.() };
  };
  const services = await startIseolRuntimeServices(value);
  assert.equal(webOptions.projectModelRoot, resolve("C:/project-model"));
  assert.equal(webOptions.projectHarnessRoot, resolve("C:/project-runs"));
  await services.dispose();
});

test("Project Workspace runtime stays unavailable when isolated roots are incomplete", async () => {
  let capability: any;
  const value = fixture({ env: { ISEOL_PROJECT_RUNTIME_ENABLED: "true", ISEOL_PROJECT_AGENT_ID: "agent-project" } });
  delete value.roots.projectModelRoot;
  value.deps.startWeb = async (options: any) => {
    capability = options.ideaLabRuntime;
    return { close: (done?: (error?: Error) => void) => done?.() };
  };
  const services = await startIseolRuntimeServices(value);
  assert.equal(capability.state, "blocked");
  assert.equal(capability.enqueueProjectRun, undefined);
  await services.dispose();
});

test("Project Workspace recovery never consumes a Run from the Idea Lab root", async () => {
  const value = fixture({ env: { ISEOL_PROJECT_RUNTIME_ENABLED: "true", ISEOL_PROJECT_AGENT_ID: "agent-project" } });
  await saveHarnessRun(value.roots.runRoot, {
    version: 1,
    request: { version: 1, mode: "project-workspace", runId: "idea-lab-root-run", objective: "old", targetRoot: "C:/other" },
    preflight: { version: 1, runId: "idea-lab-root-run", status: "blocked", policy: { version: 1, loadedAt: "2026-09-19T00:00:00.000Z", sources: [], effectiveSha256: "a".repeat(64) }, blockers: ["fixture"] },
    state: { version: 1, stage: "PREFLIGHT", status: "READY", completedStages: [], skippedStages: [], updatedAt: "2026-09-19T00:00:00.000Z" },
    evidence: [],
    updatedAt: "2026-09-19T00:00:00.000Z",
  });
  let capability: any;
  value.deps.startWeb = async (options: any) => {
    capability = options.ideaLabRuntime;
    return { close: (done?: (error?: Error) => void) => done?.() };
  };
  const services = await startIseolRuntimeServices(value);
  assert.equal(await capability.enqueueProjectRun("idea-lab-root-run"), "not-configured");
  await services.dispose();
});

test("Idea Lab worker sessions use the configured ChatGPT Web root, separate from static web content", async () => {
  const value = fixture({
    env: { ISEOL_CHATGPT_WEB_ENABLED: "false", ISEOL_CHATGPT_WEB_ROOT: "C:/fresh-chatgpt-workers" },
    ideaLabConfig: liveConfig(),
  });
  value.deps.resolveBrowser = async () => browserDriver();
  value.deps.resolveDeploy = async () => ({});
  let driverRoots: any;
  value.deps.createProductionDriver = (input: any) => { driverRoots = input.roots; return {}; };
  value.deps.createRuntime = () => ({ recover: async () => undefined, dispose: async () => undefined });
  delete value.roots;

  const services = await startIseolRuntimeServices(value);

  assert.equal(driverRoots.webRoot, resolve("C:/iseol-web"));
  assert.equal(driverRoots.webWorkerRoot, resolve("C:/fresh-chatgpt-workers"));
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

test("live dependency startup failure leaves Web available with Idea Lab blocked", async () => {
  for (const failing of ["desktop", "browser"] as const) {
    let constructed = 0;
    let recovered = 0;
    const value = fixture({ ideaLabConfig: liveConfig() });
    value.deps.resolveDeploy = async () => ({});
    value.deps.createProductionDriver = () => { constructed += 1; return {}; };
    value.deps.createRuntime = () => ({
      recover: async () => { recovered += 1; },
      dispose: async () => undefined,
    });
    if (failing === "desktop") value.deps.startDesktop = async () => { throw new Error("desktop unavailable"); };
    if (failing === "browser") value.deps.resolveBrowser = async () => { throw new Error("browser unavailable"); };

    const services = await startIseolRuntimeServices(value);
    assert.equal(services.ideaLabCapability.state, "blocked");
    assert.equal(constructed, 0);
    assert.equal(recovered, 0);
    assert.ok(value.events.includes("web:blocked"));
    await services.dispose();
  }
});

test("production driver receives the shared Desktop transport and a real sandbox adapter", async () => {
  let productionInput: any;
  const transport = { isAgentConnected: () => true, sendTask() {}, awaitResult: async () => { throw new Error("unused"); } };
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
    transport: { isAgentConnected: () => true, sendTask() {}, awaitResult: async () => { throw new Error("unused"); } },
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
    transport: { isAgentConnected: () => true, sendTask() {}, awaitResult: async () => { throw new Error("unused"); } },
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

test("unavailable configured Desktop agent keeps live Idea Lab blocked before driver construction", async () => {
  let constructed = 0;
  let recovered = 0;
  const value = fixture({ ideaLabConfig: liveConfig() });
  value.deps.startDesktop = async () => ({
    transport: {
      isAgentConnected: (agentId: string) => { assert.equal(agentId, "agent-live"); return false; },
      sendTask() {},
      awaitResult: async () => { throw new Error("unused"); },
    },
    close: async () => undefined,
  });
  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => { constructed += 1; return {}; };
  value.deps.createRuntime = () => ({
    recover: async () => { recovered += 1; },
    dispose: async () => undefined,
  });

  const services = await startIseolRuntimeServices(value);
  assert.equal(services.ideaLabCapability.state, "blocked");
  assert.equal(constructed, 0);
  assert.equal(recovered, 0);
  assert.ok(value.events.includes("web:blocked"));
  await services.dispose();
});

test("live Idea Lab waits boundedly for the configured Desktop agent to connect", async () => {
  let checks = 0;
  let sleeps = 0;
  let constructed = 0;
  const value = fixture({ ideaLabConfig: liveConfig(), agentReadyTimeoutMs: 100 });
  value.deps.startDesktop = async () => ({
    transport: {
      isAgentConnected: (agentId: string) => {
        assert.equal(agentId, "agent-live");
        checks += 1;
        return checks >= 2;
      },
      sendTask() {},
      awaitResult: async () => { throw new Error("unused"); },
    },
    close: async () => undefined,
  });
  value.deps.sleep = async (ms: number) => { assert.ok(ms > 0); sleeps += 1; };
  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => { constructed += 1; return {}; };
  value.deps.createRuntime = () => ({ recover: async () => undefined, dispose: async () => undefined });

  const services = await startIseolRuntimeServices(value);
  assert.equal(services.ideaLabCapability.state, "ready");
  assert.equal(constructed, 1);
  assert.equal(sleeps, 1);
  assert.equal(checks, 2);
  await services.dispose();
});


test("default live Idea Lab wait covers the persistent Agent max reconnect backoff", async () => {
  let checks = 0;
  let sleeps = 0;
  let constructed = 0;
  const value = fixture({ ideaLabConfig: liveConfig() });
  delete value.agentReadyTimeoutMs;
  value.deps.startDesktop = async () => ({
    transport: {
      isAgentConnected: () => { checks += 1; return checks >= 602; },
      sendTask() {},
      awaitResult: async () => { throw new Error("unused"); },
    },
    close: async () => undefined,
  });
  value.deps.sleep = async (ms: number) => { assert.ok(ms > 0 && ms <= 50); sleeps += 1; };
  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => { constructed += 1; return {}; };
  value.deps.createRuntime = () => ({ recover: async () => undefined, dispose: async () => undefined });

  const services = await startIseolRuntimeServices(value);
  assert.equal(services.ideaLabCapability.state, "ready");
  assert.equal(constructed, 1);
  assert.ok(sleeps >= 600);
  await services.dispose();
});

test("configured Desktop Agent reconnect wakes live Idea Lab runtime recovery", async () => {
  let reconnectListener:
    | ((agentId: string) => void)
    | undefined;

  let recoverCalls = 0;

  const transport = {
    isAgentConnected: (agentId: string) => {
      assert.equal(agentId, "agent-live");
      return true;
    },
    onAgentConnected(listener: (agentId: string) => void) {
      reconnectListener = listener;

      return () => {
        if (reconnectListener === listener) {
          reconnectListener = undefined;
        }
      };
    },
    sendTask() {},
    awaitResult: async () => {
      throw new Error("unused");
    },
  };

  const value = fixture({ ideaLabConfig: liveConfig() });

  value.deps.startDesktop = async () => ({
    transport,
    close: async () => undefined,
  });

  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => ({});
  value.deps.createRuntime = () => ({
    recover: async () => {
      recoverCalls += 1;
    },
    dispose: async () => undefined,
  });

  const services = await startIseolRuntimeServices(value);

  assert.equal(
    recoverCalls,
    1,
    "startup still owns the initial recovery pass",
  );

  assert.equal(
    typeof reconnectListener,
    "function",
    "runtime composition must subscribe to Agent reconnects",
  );

  reconnectListener!("other-agent");
  assert.equal(
    recoverCalls,
    1,
    "an unrelated Agent must not wake this Idea Lab runtime",
  );

  reconnectListener!("agent-live");

  assert.equal(
    recoverCalls,
    2,
    "the configured Agent reconnect must trigger recovery",
  );

  await services.dispose();
});

test("disposing runtime services unsubscribes Desktop Agent reconnect listener", async () => {
  let reconnectListener:
    | ((agentId: string) => void)
    | undefined;

  let unsubscribeCalls = 0;

  const transport = {
    isAgentConnected: () => true,
    onAgentConnected(listener: (agentId: string) => void) {
      reconnectListener = listener;

      return () => {
        unsubscribeCalls += 1;

        if (reconnectListener === listener) {
          reconnectListener = undefined;
        }
      };
    },
    sendTask() {},
    awaitResult: async () => {
      throw new Error("unused");
    },
  };

  const value = fixture({ ideaLabConfig: liveConfig() });

  value.deps.startDesktop = async () => ({
    transport,
    close: async () => undefined,
  });

  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => ({});
  value.deps.createRuntime = () => ({
    recover: async () => undefined,
    dispose: async () => undefined,
  });

  const services = await startIseolRuntimeServices(value);

  assert.equal(typeof reconnectListener, "function");

  await services.dispose();

  assert.equal(
    unsubscribeCalls,
    1,
    "dispose must unsubscribe the Desktop Agent reconnect listener",
  );

  assert.equal(
    reconnectListener,
    undefined,
    "disposed runtime must not retain its reconnect listener",
  );
});

test("startup failure unsubscribes Desktop Agent reconnect listener", async () => {
  let unsubscribeCalls = 0;

  const transport = {
    isAgentConnected: () => true,
    onAgentConnected() {
      return () => {
        unsubscribeCalls += 1;
      };
    },
    sendTask() {},
    awaitResult: async () => {
      throw new Error("unused");
    },
  };

  const value = fixture({ ideaLabConfig: liveConfig() });

  value.deps.startDesktop = async () => ({
    transport,
    close: async () => undefined,
  });

  value.deps.resolveDeploy = async () => ({});
  value.deps.createProductionDriver = () => ({});
  value.deps.createRuntime = () => ({
    recover: async () => undefined,
    dispose: async () => undefined,
  });

  value.deps.startWeb = async () => {
    throw new Error("web startup failed");
  };

  await assert.rejects(
    () => startIseolRuntimeServices(value),
    /web startup failed/,
  );

  assert.equal(
    unsubscribeCalls,
    1,
    "startup failure must unsubscribe the Desktop Agent reconnect listener",
  );
});
