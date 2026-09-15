import assert from "node:assert/strict";
import test from "node:test";
import { createPlaywrightBrowserBackend } from "../src/chatgpt-web/playwright-browser-backend.js";

const config = { enabled: true as const, profileRoot: "C:\\temp\\chatgpt-profile", headless: true };

test("backend recreates its owned page after conversation close and disposes the persistent context", async () => {
  let pageCount = 0;
  let contextCloseCount = 0;
  const pages: Array<{ closed: boolean; urls: string[] }> = [];

  const context = {
    async newPage() {
      pageCount += 1;
      const state = { closed: false, urls: [] as string[] };
      pages.push(state);
      return {
        async goto(url: string) { if (state.closed) throw new Error("page closed"); state.urls.push(url); },
        url() { return state.urls.at(-1) ?? "about:blank"; },
        locator() { throw new Error("locator not used by lifecycle test"); },
        isClosed() { return state.closed; },
        async close() { state.closed = true; },
      };
    },
    async close() { contextCloseCount += 1; },
  };

  const backend = await (createPlaywrightBrowserBackend as any)(config, {
    launchPersistentContext: async () => context,
  });

  await backend.navigate("https://chatgpt.com/");
  assert.equal(pageCount, 1);
  await backend.closeOwnedPage();
  assert.equal(pages[0]?.closed, true);

  await backend.navigate("https://chatgpt.com/c/conv-2");
  assert.equal(pageCount, 2, "next conversation must get a fresh owned page");
  assert.deepEqual(pages[1]?.urls, ["https://chatgpt.com/c/conv-2"]);

  await backend.dispose();
  assert.equal(contextCloseCount, 1);
  await assert.rejects(() => backend.navigate("https://chatgpt.com/"), /disposed/i);
});

test("composer operations ignore hidden fallback editors", async () => {
  let filled = "";
  const context = {
    async newPage() {
      return {
        async goto() {},
        url() { return "https://chatgpt.com/"; },
        locator(selector: string) {
          const composerSelector = selector.includes("textarea");
          return {
            async count() { return composerSelector ? (selector.includes(":visible") ? 1 : 2) : 0; },
            async fill(value: string) { filled = value; },
          };
        },
        isClosed() { return false; },
        async close() {},
      };
    },
    async close() {},
  };
  const backend = await (createPlaywrightBrowserBackend as any)(config, {
    launchPersistentContext: async () => context,
  });
  assert.equal(await backend.composerCount(), 1);
  await backend.fillComposer("hello");
  assert.equal(filled, "hello");
  await backend.dispose();
});


test("backend captures the latest assistant source through its turn copy action", async () => {
  const raw = "+assert.match(html, new RegExp(`data-action=\"${action}\"`));";
  let clicks = 0;
  let evaluations = 0;
  const copy = { async count() { return 1; }, async dispatchEvent(type: string) { assert.equal(type, "click"); clicks += 1; } };
  const turn = {
    async count() { return 1; },
    locator(selector: string) { assert.equal(selector, 'button[data-testid="copy-turn-action-button"]'); return copy; },
  };
  const assistant = {
    async count() { return 1; }, last() { return this; },
    locator(selector: string) { assert.match(selector, /copy-turn-action-button/); return turn; },
  };
  const page = {
    locator(selector: string) { assert.equal(selector, '[data-message-author-role="assistant"]'); return assistant; },
    async evaluate(expression: unknown) { assert.equal(typeof expression, "string"); evaluations += 1; return evaluations === 2 ? raw : undefined; },
    async waitForFunction(expression: unknown) { assert.equal(typeof expression, "string"); },
    isClosed() { return false; }, async close() {},
  };
  const context = { async newPage() { return page; }, async close() {} };
  const backend = await (createPlaywrightBrowserBackend as any)(config, { launchPersistentContext: async () => context });
  assert.equal(await (backend as any).latestAssistantRawText(), raw);
  assert.equal(clicks, 1);
  await backend.dispose();
});


test("backend detects the visible ChatGPT temporary request-limit message", async () => {
  const page = {
    locator(selector: string) {
      assert.equal(selector, "body");
      return {
        async innerText() {
          return "요청이 너무 많습니다\n요청을 너무 빠르게 보내고 있습니다. 데이터를 보호하기 위해 대화에 대한 액세스가 일시적으로 제한되었습니다.\n몇 분 후 다시 시도해 주세요.";
        },
      };
    },
    isClosed() { return false; },
    async close() {},
  };
  const context = { async newPage() { return page; }, async close() {} };
  const backend = await (createPlaywrightBrowserBackend as any)(config, {
    launchPersistentContext: async () => context,
  });
  assert.equal(await (backend as any).temporaryRestrictionCount(), 1);
  await backend.dispose();
});

test("backend distinguishes conversation exhaustion from account usage limits", async () => {
  let bodyText = "You've reached the maximum length for this conversation. Start a new chat to continue.";
  const page = {
    locator(selector: string) { assert.equal(selector, "body"); return { async innerText() { return bodyText; } }; },
    isClosed() { return false; }, async close() {},
  };
  const context = { async newPage() { return page; }, async close() {} };
  const backend = await (createPlaywrightBrowserBackend as any)(config, { launchPersistentContext: async () => context });
  assert.equal(await (backend as any).conversationLimitCount(), 1);
  assert.equal(await (backend as any).usageLimitCount(), 0);
  bodyText = "You've reached your GPT-5 message limit. Try again later.";
  assert.equal(await (backend as any).conversationLimitCount(), 0);
  assert.equal(await (backend as any).usageLimitCount(), 1);
  await backend.dispose();
});

test("backend dismisses the temporary request-limit popup", async () => {
  let clicks = 0;
  const page = {
    locator(selector: string) { assert.equal(selector, "body"); return { async innerText() { return "요청이 너무 많습니다\n몇 분 후 다시 시도해 주세요."; } }; },
    getByRole(role: string, options: { name: RegExp }) {
      assert.equal(role, "button"); assert.match("알겠습니다", options.name);
      return { async count() { return 1; }, async click() { clicks += 1; } };
    },
    isClosed() { return false; }, async close() {},
  };
  const context = { async newPage() { return page; }, async close() {} };
  const backend = await (createPlaywrightBrowserBackend as any)(config, { launchPersistentContext: async () => context });
  assert.equal(await (backend as any).dismissTemporaryRestriction(), true);
  assert.equal(clicks, 1);
  await backend.dispose();
});

test("backend treats model quota messages as usage limits rather than conversation exhaustion", async () => {
  let bodyText = "You've reached the GPT-5 limit. Please try again later.";
  const page = {
    locator(selector: string) { assert.equal(selector, "body"); return { async innerText() { return bodyText; } }; },
    isClosed() { return false; }, async close() {},
  };
  const context = { async newPage() { return page; }, async close() {} };
  const backend = await (createPlaywrightBrowserBackend as any)(config, { launchPersistentContext: async () => context });
  assert.equal(await (backend as any).usageLimitCount(), 1);
  bodyText = "GPT-5 사용 한도에 도달했습니다. 나중에 다시 시도해 주세요.";
  assert.equal(await (backend as any).usageLimitCount(), 1);
  assert.equal(await (backend as any).conversationLimitCount(), 0);
  await backend.dispose();
});

test("backend recognizes reached-the-limit-for-this-conversation wording", async () => {
  const page = {
    locator(selector: string) { assert.equal(selector, "body"); return { async innerText() { return "You've reached the limit for this conversation. Start a new chat to continue."; } }; },
    isClosed() { return false; }, async close() {},
  };
  const context = { async newPage() { return page; }, async close() {} };
  const backend = await (createPlaywrightBrowserBackend as any)(config, { launchPersistentContext: async () => context });
  assert.equal(await (backend as any).conversationLimitCount(), 1);
  assert.equal(await (backend as any).usageLimitCount(), 0);
  await backend.dispose();
});
