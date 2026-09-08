import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptWebAuthenticationRequiredError, ChatGptWebSessionLostError } from "../src/chatgpt-web/browser-adapter.js";
import { createPlaywrightChatGptBrowserDriver, type PlaywrightBrowserBackend } from "../src/chatgpt-web/playwright-browser-driver.js";

function fakeBackend(overrides: Partial<PlaywrightBrowserBackend> = {}) {
  const urls: string[] = [];
  let currentUrl = "https://chatgpt.com/";
  let closed = 0;
  const backend: PlaywrightBrowserBackend = {
    navigate: async (url) => { urls.push(url); currentUrl = url; },
    currentUrl: async () => currentUrl,
    composerCount: async () => 1,
    authenticationRequiredCount: async () => 0,
    closeOwnedPage: async () => { closed += 1; },
    ...overrides,
  };
  return { backend, urls, closed: () => closed };
}

const config = { enabled: true as const, profileRoot: "C:\\temp\\chatgpt-profile", headless: true };

 test("new conversation opens only the canonical root and may remain unassigned before submit", async () => {
  const { backend, urls } = fakeBackend();
  const driver = await createPlaywrightChatGptBrowserDriver(config, { backend });
  const opened = await driver.openOrResumeConversation({ prompt: "x", promptSha256: "sha" });
  assert.deepEqual(opened, {});
  assert.deepEqual(urls, ["https://chatgpt.com/"]);
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
test("missing or ambiguous composer loses the session", async () => {
  for (const count of [0, 2]) {
    const item = fakeBackend({ composerCount: async () => count });
    const driver = await createPlaywrightChatGptBrowserDriver(config, { backend: item.backend });
    await assert.rejects(
      () => driver.openOrResumeConversation({ prompt: "x", promptSha256: "sha" }),
      ChatGptWebSessionLostError,
    );
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
