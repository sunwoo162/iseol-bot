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
  const copy = { async count() { return 1; }, async click() { clicks += 1; } };
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
    async evaluate() { evaluations += 1; return evaluations === 2 ? raw : undefined; },
    async waitForFunction() {},
    isClosed() { return false; }, async close() {},
  };
  const context = { async newPage() { return page; }, async close() {} };
  const backend = await (createPlaywrightBrowserBackend as any)(config, { launchPersistentContext: async () => context });
  assert.equal(await (backend as any).latestAssistantRawText(), raw);
  assert.equal(clicks, 1);
  await backend.dispose();
});
