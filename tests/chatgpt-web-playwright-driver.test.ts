import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptWebAuthenticationRequiredError, ChatGptWebSessionLostError } from "../src/chatgpt-web/browser-adapter.js";
import { createPlaywrightChatGptBrowserDriver, type PlaywrightBrowserBackend } from "../src/chatgpt-web/playwright-browser-driver.js";

function fakeBackend(overrides: Partial<PlaywrightBrowserBackend> = {}) {
  const urls: string[] = [];
  let currentUrl = "https://chatgpt.com/";
  let closed = 0;
  let sends = 0;
  let filled = "";
  let assistantText: string | null = null;
  let assistantCount = 0;
  let generatingCount = 0;
  const backend: PlaywrightBrowserBackend & Record<string, any> = {
    navigate: async (url) => { urls.push(url); currentUrl = url; },
    currentUrl: async () => currentUrl,
    composerCount: async () => 1,
    authenticationRequiredCount: async () => 0,
    fillComposer: async (value: string) => { filled = value; },
    sendPrompt: async () => { sends += 1; },
    assistantMessageCount: async () => assistantCount,
    latestAssistantText: async () => assistantText,
    generationControlCount: async () => generatingCount,
    closeOwnedPage: async () => { closed += 1; },
    dispose: async () => undefined,
    ...overrides,
  };
  return { backend, urls, closed: () => closed, sends: () => sends, filled: () => filled, setAssistant: (text: string | null, count = 1) => { assistantText = text; assistantCount = count; }, setGenerating: (count: number) => { generatingCount = count; }, setUrl: (url: string) => { currentUrl = url; } };
}

const config = { enabled: true as const, profileRoot: "C:\\temp\\chatgpt-profile", headless: true };

 test("new conversation opens only the canonical root and may remain unassigned before submit", async () => {
  const { backend, urls } = fakeBackend();
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend });
  const opened = await driver.openOrResumeConversation({ prompt: "x", promptSha256: "sha" });
  assert.deepEqual(opened, {});
  assert.deepEqual(urls, ["https://chatgpt.com/"]);
});
test("new conversation waits boundedly for authenticated composer readiness", async () => {
  let now = 0;
  let composerChecks = 0;
  const item = fakeBackend({
    composerCount: async () => {
      composerChecks += 1;
      return composerChecks < 3 ? 0 : 1;
    },
  });
  const driver = await createPlaywrightChatGptBrowserDriver(config, {
    backend: item.backend,
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
  } as any);
  assert.deepEqual(await driver.openOrResumeConversation({ prompt: "x", promptSha256: "sha" }), {});
  assert.equal(composerChecks, 3);
  assert.ok(now >= 200);
});
test("resume navigates to and proves the exact requested conversation", async () => {
  const { backend, urls } = fakeBackend();
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend });
  const opened = await driver.openOrResumeConversation({ conversationRef: "conv-2", prompt: "x", promptSha256: "sha" });
  assert.deepEqual(opened, { conversationRef: "conv-2" });
  assert.deepEqual(urls, ["https://chatgpt.com/c/conv-2"]);
});

test("resume rejects a post-navigation conversation identity mismatch", async () => {
  const { backend } = fakeBackend({
    navigate: async () => undefined,
    currentUrl: async () => "https://chatgpt.com/c/other",
  });
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend });
  await assert.rejects(
    () => driver.openOrResumeConversation({ conversationRef: "conv-2", prompt: "x", promptSha256: "sha" }),
    ChatGptWebSessionLostError,
  );
});

test("login URL or login surface requires authentication", async () => {
  const authUrl = fakeBackend({ currentUrl: async () => "https://chatgpt.com/auth/login", composerCount: async () => 0 });
  const authUrlDriver = await createPlaywrightChatGptBrowserDriver(config, { backend: authUrl.backend });
  await assert.rejects(() => authUrlDriver.openOrResumeConversation({ prompt: "x", promptSha256: "sha" }), ChatGptWebAuthenticationRequiredError);

  const authSurface = fakeBackend({ composerCount: async () => 0, authenticationRequiredCount: async () => 2 });
  const authSurfaceDriver = await createPlaywrightChatGptBrowserDriver(config, { backend: authSurface.backend });
  await assert.rejects(() => authSurfaceDriver.openOrResumeConversation({ prompt: "x", promptSha256: "sha" }), ChatGptWebAuthenticationRequiredError);
});
test("guest composer with a login surface still requires authentication", async () => {
  const guest = fakeBackend({ composerCount: async () => 1, authenticationRequiredCount: async () => 2 });
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: guest.backend });
  await assert.rejects(
    () => driver.openOrResumeConversation({ prompt: "x", promptSha256: "sha" }),
    ChatGptWebAuthenticationRequiredError,
  );
});
test("missing composer waits only for the bounded readiness window while ambiguity fails immediately", async () => {
  for (const count of [0, 2]) {
    let now = 0;
    const item = fakeBackend({ composerCount: async () => count });
    const driver = await createPlaywrightChatGptBrowserDriver(config, {
      backend: item.backend,
      now: () => now,
      sleep: async (ms: number) => { now += ms; },
    } as any);
    await assert.rejects(
      () => driver.openOrResumeConversation({ prompt: "x", promptSha256: "sha" }),
      ChatGptWebSessionLostError,
    );
    if (count === 0) assert.ok(now >= 5_000);
    else assert.equal(now, 0);
  }
});

test("browser failures are bounded session-loss errors and close only the owned page", async () => {
  const broken = fakeBackend({ navigate: async () => { throw new Error("C:/secret/profile detail"); } });
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: broken.backend });
  await assert.rejects(
    () => driver.openOrResumeConversation({ prompt: "sensitive prompt", promptSha256: "sha" }),
    (error: unknown) => error instanceof ChatGptWebSessionLostError && !error.message.includes("secret") && !error.message.includes("sensitive"),
  );

  const closable = fakeBackend();
  const closeDriver = await createPlaywrightChatGptBrowserDriver(config, { backend: closable.backend });
  await closeDriver.closeConversation("conv-1");
  assert.equal(closable.closed(), 1);
});

test("submit sends one prompt per SHA and captures the first canonical conversation ref", async () => {
  const item = fakeBackend();
  let sendCalls = 0;
  item.backend.sendPrompt = async () => {
    sendCalls += 1;
    item.setUrl("https://chatgpt.com/c/conv-created");
  };
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: item.backend } as any);
  await driver.openOrResumeConversation({ prompt: "payload", promptSha256: "sha-1" });
  assert.deepEqual(await driver.submitPrompt({ prompt: "payload", promptSha256: "sha-1" }), { conversationRef: "conv-created" });
  assert.deepEqual(await driver.submitPrompt({ conversationRef: "conv-created", prompt: "payload", promptSha256: "sha-1" }), { conversationRef: "conv-created" });
  assert.equal(sendCalls, 1);
  assert.equal(item.filled(), "payload");
});

test("submit revalidates the exact conversation URL before browser mutation", async () => {
  const item = fakeBackend();
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: item.backend } as any);
  await driver.openOrResumeConversation({ conversationRef: "conv-1", prompt: "payload", promptSha256: "sha-2" });
  item.setUrl("https://chatgpt.com/c/other");
  await assert.rejects(
    () => driver.submitPrompt({ conversationRef: "conv-1", prompt: "payload", promptSha256: "sha-2" }),
    ChatGptWebSessionLostError,
  );
  assert.equal(item.sends(), 0);
  assert.equal(item.filled(), "");
});


test("structured result waits for a stable completed assistant message and parses raw or fenced JSON", async () => {
  let now = 0;
  const item = fakeBackend();
  item.setUrl("https://chatgpt.com/c/conv-1");
  const deps = { backend: item.backend, now: () => now, sleep: async (ms: number) => { now += ms; } } as any;
  const driver = await createPlaywrightChatGptBrowserDriver(config, deps);
  await driver.submitPrompt({ conversationRef: "conv-1", prompt: "first", promptSha256: "result-sha-1" });
  item.setAssistant('{"version":1}', 1);
  assert.deepEqual(await driver.readStructuredResult({ conversationRef: "conv-1", timeoutMs: 2000 }), { version: 1 });

  now = 0;
  await driver.submitPrompt({ conversationRef: "conv-1", prompt: "second", promptSha256: "result-sha-2" });
  item.setAssistant('```json\n{"version":2}\n```', 2);
  assert.deepEqual(await driver.readStructuredResult({ conversationRef: "conv-1", timeoutMs: 2000 }), { version: 2 });
});

test("structured result rejects prose multiple JSON malformed JSON and oversized output", async () => {
  for (const text of [
    'result: {"version":1}',
    '{"version":1} {"version":2}',
    '{bad json}',
    JSON.stringify({ value: "x".repeat(262_145) }),
  ]) {
    let now = 0;
    const item = fakeBackend();
    item.setUrl("https://chatgpt.com/c/conv-1");
    const deps = { backend: item.backend, now: () => now, sleep: async (ms: number) => { now += ms; } } as any;
    const driver = await createPlaywrightChatGptBrowserDriver(config, deps);
    await driver.submitPrompt({ conversationRef: "conv-1", prompt: "payload", promptSha256: "reject-sha" });
    item.setAssistant(text, 1);
    await assert.rejects(
      () => driver.readStructuredResult({ conversationRef: "conv-1", timeoutMs: 2000 }),
      (error: unknown) => error instanceof Error && error.name === "ChatGptWebStructuredResultError",
    );
  }
});

test("generation must settle for 750ms and timeout is session loss", async () => {
  let now = 0;
  const item = fakeBackend();
  item.setUrl("https://chatgpt.com/c/conv-1");
  const sleep = async (ms: number) => { now += ms; if (now >= 400) item.setGenerating(0); };
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: item.backend, now: () => now, sleep } as any);
  await driver.submitPrompt({ conversationRef: "conv-1", prompt: "payload", promptSha256: "settle-sha" });
  item.setAssistant('{"ok":true}', 1);
  item.setGenerating(1);
  assert.deepEqual(await driver.readStructuredResult({ conversationRef: "conv-1", timeoutMs: 2000 }), { ok: true });
  assert.ok(now >= 1150);

  let timedNow = 0;
  const timedItem = fakeBackend();
  timedItem.setUrl("https://chatgpt.com/c/conv-1");
  const timed = await createPlaywrightChatGptBrowserDriver(config, {
    backend: timedItem.backend, now: () => timedNow, sleep: async (ms: number) => { timedNow += ms; },
  } as any);
  await timed.submitPrompt({ conversationRef: "conv-1", prompt: "payload", promptSha256: "timeout-sha" });
  timedItem.setAssistant('{"late":true}', 1);
  timedItem.setGenerating(1);
  await assert.rejects(
    () => timed.readStructuredResult({ conversationRef: "conv-1", timeoutMs: 500 }),
    ChatGptWebSessionLostError,
  );
});

test("probe classifies exact ready auth-required and lost states", async () => {
  const item = fakeBackend();
  item.setUrl("https://chatgpt.com/c/conv-1");
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: item.backend } as any);
  assert.equal(await driver.probeConversation("conv-1"), "ready");

  item.setUrl("https://chatgpt.com/auth/login");
  assert.equal(await driver.probeConversation("conv-1"), "auth-required");

  item.setUrl("https://chatgpt.com/c/other");
  assert.equal(await driver.probeConversation("conv-1"), "lost");
});

test("probe treats a guest composer with login controls as auth-required", async () => {
  const guest = fakeBackend({ authenticationRequiredCount: async () => 2 });
  guest.setUrl("https://chatgpt.com/c/conv-1");
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: guest.backend } as any);
  assert.equal(await driver.probeConversation("conv-1"), "auth-required");
});

test("the same prompt SHA is deduplicated per conversation rather than globally", async () => {
  const item = fakeBackend();
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: item.backend } as any);

  item.setUrl("https://chatgpt.com/c/conv-a");
  await driver.submitPrompt({ conversationRef: "conv-a", prompt: "payload", promptSha256: "same-sha" });
  item.setUrl("https://chatgpt.com/c/conv-b");
  await driver.submitPrompt({ conversationRef: "conv-b", prompt: "payload", promptSha256: "same-sha" });

  assert.equal(item.sends(), 2);
});

test("first submit waits boundedly for ChatGPT to assign the canonical conversation URL", async () => {
  let now = 0;
  const item = fakeBackend();
  item.backend.sendPrompt = async () => undefined;
  const sleep = async (ms: number) => {
    now += ms;
    if (now >= 300) item.setUrl("https://chatgpt.com/c/conv-delayed");
  };
  const driver = await createPlaywrightChatGptBrowserDriver(config, {
    backend: item.backend, now: () => now, sleep,
  } as any);

  assert.deepEqual(
    await driver.submitPrompt({ prompt: "payload", promptSha256: "delayed-sha" }),
    { conversationRef: "conv-delayed" },
  );
  assert.ok(now >= 300);
});

test("result reading ignores assistant messages that existed before the submitted turn", async () => {
  let now = 0;
  const item = fakeBackend();
  item.setUrl("https://chatgpt.com/c/conv-1");
  item.setAssistant('{"old":true}', 1);
  const sleep = async (ms: number) => {
    now += ms;
    if (now >= 900) item.setAssistant('{"new":true}', 2);
  };
  const driver = await createPlaywrightChatGptBrowserDriver(config, {
    backend: item.backend, now: () => now, sleep,
  } as any);
  await driver.submitPrompt({ conversationRef: "conv-1", prompt: "next", promptSha256: "new-turn" });

  assert.deepEqual(
    await driver.readStructuredResult({ conversationRef: "conv-1", timeoutMs: 2500 }),
    { new: true },
  );
  assert.ok(now >= 1650);
});

test("result reading fails closed when this driver has no pending submission baseline", async () => {
  let now = 0;
  const item = fakeBackend();
  item.setUrl("https://chatgpt.com/c/conv-1");
  item.setAssistant('{"stale":true}', 1);
  const driver = await createPlaywrightChatGptBrowserDriver(config, {
    backend: item.backend, now: () => now, sleep: async (ms: number) => { now += ms; },
  } as any);

  await assert.rejects(
    () => driver.readStructuredResult({ conversationRef: "conv-1", timeoutMs: 1000 }),
    ChatGptWebSessionLostError,
  );
});

test("concurrent duplicate submissions share one in-flight browser send", async () => {
  const item = fakeBackend();
  item.setUrl("https://chatgpt.com/c/conv-1");
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: item.backend } as any);
  const input = { conversationRef: "conv-1", prompt: "payload", promptSha256: "concurrent-sha" };

  const [first, second] = await Promise.all([driver.submitPrompt(input), driver.submitPrompt(input)]);

  assert.equal(item.sends(), 1);
  assert.deepEqual(first, { conversationRef: "conv-1" });
  assert.deepEqual(second, { conversationRef: "conv-1" });
});

test("restart resumes the exact persisted conversation without creating a replacement", async () => {
  const shared = { url: "https://chatgpt.com/", sends: 0 };
  const first = fakeBackend({
    currentUrl: async () => shared.url,
    navigate: async (url) => { shared.url = url; },
    sendPrompt: async () => { shared.sends += 1; shared.url = "https://chatgpt.com/c/conv-persisted"; },
  });
  const driverA = await createPlaywrightChatGptBrowserDriver(config, { backend: first.backend });
  await driverA.openOrResumeConversation({ prompt: "payload", promptSha256: "restart-sha" });
  const submitted = await driverA.submitPrompt({ prompt: "payload", promptSha256: "restart-sha" });
  assert.deepEqual(submitted, { conversationRef: "conv-persisted" });

  const resumeUrls: string[] = [];
  const second = fakeBackend({
    currentUrl: async () => shared.url,
    navigate: async (url) => { resumeUrls.push(url); shared.url = url; },
  });
  const driverB = await createPlaywrightChatGptBrowserDriver(config, { backend: second.backend });
  const resumed = await driverB.openOrResumeConversation({ conversationRef: "conv-persisted", prompt: "payload", promptSha256: "restart-sha" });
  assert.deepEqual(resumed, { conversationRef: "conv-persisted" });
  assert.deepEqual(resumeUrls, ["https://chatgpt.com/c/conv-persisted"]);
  assert.equal(shared.sends, 1);
});
