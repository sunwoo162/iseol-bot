import assert from "node:assert/strict";
import test from "node:test";
import type { WebWorkerSession } from "../src/chatgpt-web/contracts.js";
import type { CompiledWebPrompt } from "../src/chatgpt-web/prompt-compiler.js";
import {
  createProductionChatGptWebAdapter,
  type ChatGptBrowserDriver,
} from "../src/chatgpt-web/production-browser-adapter.js";
import {
  resolveChatGptWebBridgeConfig,
  startChatGptWebBridgeService,
} from "../src/chatgpt-web/browser-service.js";
import { ChatGptWebAuthenticationRequiredError, ChatGptWebSessionLostError } from "../src/chatgpt-web/browser-adapter.js";

const session: WebWorkerSession = {
  version: 1, sessionId: "session-1", runId: "run-1", stage: "IMPLEMENT", generation: 1,
  policySha256: "a".repeat(64), status: "ready", createdAt: "2026-09-08T01:00:00.000Z",
};
const prompt: CompiledWebPrompt = {
  version: 1, kind: "initial", runId: "run-1", stage: "IMPLEMENT", generation: 1,
  policySha256: "a".repeat(64), body: "reason safely", sha256: "b".repeat(64),
};

test("ChatGPT Web bridge bootstrap is opt-in and independent of other Iseol services", () => {
  assert.deepEqual(resolveChatGptWebBridgeConfig({}), { enabled: false, workerRoot: "data/runs" });
  assert.deepEqual(resolveChatGptWebBridgeConfig({ ISEOL_WEB_HOST: "0.0.0.0", ISEOL_DESKTOP_AGENT_TOKEN: "desktop" }), { enabled: false, workerRoot: "data/runs" });
  assert.deepEqual(resolveChatGptWebBridgeConfig({ ISEOL_CHATGPT_WEB_ENABLED: "true", ISEOL_CHATGPT_WEB_ROOT: "data/custom-runs" }), { enabled: true, workerRoot: "data/custom-runs" });
  assert.throws(() => resolveChatGptWebBridgeConfig({ ISEOL_CHATGPT_WEB_ENABLED: "yes" }), /true|false/i);
});

test("enabled bridge fails closed when no browser driver is installed", async () => {
  await assert.rejects(startChatGptWebBridgeService({ enabled: true, workerRoot: "data/runs" }), /browser driver.*required/i);
  assert.deepEqual(await startChatGptWebBridgeService({ enabled: false, workerRoot: "data/runs" }), { enabled: false });
});
test("production adapter exposes only bounded conversation operations", async () => {
  const calls: string[] = [];
  const driver: ChatGptBrowserDriver = {
    openOrResumeConversation: async () => { calls.push("open"); return { conversationRef: "conv-1" }; },
    submitPrompt: async () => { calls.push("submit"); },
    readStructuredResult: async () => { calls.push("read"); return { version: 1 }; },
    probeConversation: async () => { calls.push("probe"); return "ready"; },
    closeConversation: async () => { calls.push("close"); },
  };
  assert.deepEqual(Object.keys(driver).sort(), ["closeConversation", "openOrResumeConversation", "probeConversation", "readStructuredResult", "submitPrompt"]);
  const adapter = createProductionChatGptWebAdapter(driver);
  const opened = await adapter.openOrResumeSession(session, prompt);
  assert.deepEqual(opened, { conversationRef: "conv-1" });
  await adapter.submitTurn({ ...session, conversationRef: "conv-1" }, prompt);
  await adapter.awaitStructuredResult({ ...session, conversationRef: "conv-1" }, 1000);
  assert.equal(await adapter.probeSession({ ...session, conversationRef: "conv-1" }), "ready");
  await adapter.closeSession({ ...session, conversationRef: "conv-1" });
  assert.deepEqual(calls, ["open", "submit", "read", "probe", "close"]);
});
test("auth and navigation failures are classified without leaking browser credentials", async () => {
  const authDriver: ChatGptBrowserDriver = {
    openOrResumeConversation: async () => { throw new ChatGptWebAuthenticationRequiredError("login required"); },
    submitPrompt: async () => undefined,
    readStructuredResult: async () => ({ version: 1 }),
    probeConversation: async () => "auth-required",
    closeConversation: async () => undefined,
  };
  const authAdapter = createProductionChatGptWebAdapter(authDriver);
  await assert.rejects(authAdapter.openOrResumeSession(session, prompt), ChatGptWebAuthenticationRequiredError);

  const lostDriver: ChatGptBrowserDriver = {
    openOrResumeConversation: async () => ({ conversationRef: "conv-2" }),
    submitPrompt: async () => { throw new Error("selector not found"); },
    readStructuredResult: async () => { throw new Error("navigation detached"); },
    probeConversation: async () => "lost",
    closeConversation: async () => undefined,
  };
  const lostAdapter = createProductionChatGptWebAdapter(lostDriver);
  await assert.rejects(lostAdapter.submitTurn({ ...session, conversationRef: "conv-2" }, prompt), ChatGptWebSessionLostError);
  await assert.rejects(lostAdapter.awaitStructuredResult({ ...session, conversationRef: "conv-2" }, 1000), ChatGptWebSessionLostError);
});
test("controlled smoke rejects mutation intents unless an explicit workspace is allowed", async () => {
  const smokeDriver: ChatGptBrowserDriver = {
    openOrResumeConversation: async () => ({ conversationRef: "smoke-conv" }),
    submitPrompt: async () => undefined,
    readStructuredResult: async () => ({
      version: 1, runId: "smoke-run", stage: "ANALYZE", generation: 1,
      summary: "smoke", decisions: [], outcome: "continue",
      intents: [{ version: 1, intentId: "smoke-intent", runId: "smoke-run", stage: "ANALYZE", workspaceRoot: "C:/tmp/smoke", policySha256: "0".repeat(64), kind: "GIT_INSPECT", cwd: "." }],
    }),
    probeConversation: async () => "ready",
    closeConversation: async () => undefined,
  };
  const { runChatGptWebControlledSmoke } = await import("../src/chatgpt-web/smoke.js");
  await assert.rejects(runChatGptWebControlledSmoke({ driver: smokeDriver }), /explicit temporary workspace/i);
  const allowed = await runChatGptWebControlledSmoke({ driver: smokeDriver, mutationWorkspace: "C:/tmp/smoke" });
  assert.equal(allowed.intentCount, 1);
});