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
