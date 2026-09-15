import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { PlaywrightBrowserDriverConfig } from "./playwright-browser-config.js";

export interface PlaywrightBrowserBackend {
  navigate(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  composerCount(): Promise<number>;
  authenticationRequiredCount(): Promise<number>;
  temporaryRestrictionCount(): Promise<number>;
  fillComposer(value: string): Promise<void>;
  sendPrompt(): Promise<void>;
  assistantMessageCount(): Promise<number>;
  latestAssistantText(): Promise<string | null>;
  latestAssistantRawText(): Promise<string | null>;
  generationControlCount(): Promise<number>;
  closeOwnedPage(): Promise<void>;
  dispose(): Promise<void>;
}

type BackendDeps = {
  launchPersistentContext?: (
    profileRoot: string,
    options: { executablePath?: string; headless: boolean },
  ) => Promise<BrowserContext>;
};

const COMPOSER_SELECTOR = 'textarea:visible, [contenteditable="true"][role="textbox"]:visible, [contenteditable="true"][data-lexical-editor="true"]:visible';
const AUTH_SELECTOR = 'a[href*="/auth/login"], a[href*="/auth/signup"], a[href*="/auth/sign-up"]';
const TEMPORARY_RESTRICTION_TEXT = /(?:too many requests|sending requests too quickly|access (?:has been )?temporarily limited|요청이 너무 많습니다|요청을 너무 빠르게 보내고 있습니다|액세스가 일시적으로 제한)/i;
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const COPY_SELECTOR = 'button[data-testid="copy-turn-action-button"]';
const COPY_CAPTURE_TIMEOUT_MS = 2_000;
const INSTALL_CLIPBOARD_CAPTURE_SCRIPT = `(() => {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error("clipboard unavailable");
  const state = {
    clipboard,
    writeDescriptor: Object.getOwnPropertyDescriptor(clipboard, "write"),
    writeTextDescriptor: Object.getOwnPropertyDescriptor(clipboard, "writeText"),
    text: undefined,
    items: undefined,
  };
  globalThis.__iseolClipboardCapture = state;
  Object.defineProperty(clipboard, "write", {
    configurable: true,
    value: async (items) => { state.items = items; },
  });
  Object.defineProperty(clipboard, "writeText", {
    configurable: true,
    value: async (value) => { state.text = String(value); },
  });
})()`;

const WAIT_CLIPBOARD_CAPTURE_SCRIPT = `Boolean(
  globalThis.__iseolClipboardCapture
  && (globalThis.__iseolClipboardCapture.text !== undefined
    || globalThis.__iseolClipboardCapture.items !== undefined)
)`;
const READ_CLIPBOARD_CAPTURE_SCRIPT = `(async () => {
  const state = globalThis.__iseolClipboardCapture;
  if (!state) throw new Error("clipboard capture unavailable");
  if (typeof state.text === "string") return state.text;
  for (const item of state.items ?? []) {
    if (!item?.types?.includes?.("text/plain")) continue;
    const blob = await item.getType("text/plain");
    return await blob.text();
  }
  throw new Error("copied response has no text/plain payload");
})()`;
const RESTORE_CLIPBOARD_CAPTURE_SCRIPT = `(() => {
  const state = globalThis.__iseolClipboardCapture;
  if (!state) return;
  const clipboard = state.clipboard;
  if (state.writeDescriptor) Object.defineProperty(clipboard, "write", state.writeDescriptor);
  else delete clipboard.write;
  if (state.writeTextDescriptor) Object.defineProperty(clipboard, "writeText", state.writeTextDescriptor);
  else delete clipboard.writeText;
  delete globalThis.__iseolClipboardCapture;
})()`;

const GENERATING_SELECTOR = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]';

export async function createPlaywrightBrowserBackend(
  config: Extract<PlaywrightBrowserDriverConfig, { enabled: true }>,
  deps: BackendDeps = {},
): Promise<PlaywrightBrowserBackend> {
  const launchPersistentContext = deps.launchPersistentContext
    ?? ((profileRoot, options) => chromium.launchPersistentContext(profileRoot, options));
  const context = await launchPersistentContext(config.profileRoot, {
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    headless: config.headless,
  });
  let page: Page | null = await context.newPage();
  let disposed = false;

  async function ownedPage(): Promise<Page> {
    if (disposed) throw new Error("ChatGPT browser backend is disposed");
    if (!page || page.isClosed()) page = await context.newPage();
    return page;
  }

  return {
    async navigate(url) { await (await ownedPage()).goto(url, { waitUntil: "domcontentloaded" }); },
    async currentUrl() { return (await ownedPage()).url(); },
    async composerCount() { return (await ownedPage()).locator(COMPOSER_SELECTOR).count(); },
    async authenticationRequiredCount() { return (await ownedPage()).locator(AUTH_SELECTOR).count(); },
    async temporaryRestrictionCount() {
      const text = await (await ownedPage()).locator("body").innerText();
      return TEMPORARY_RESTRICTION_TEXT.test(text) ? 1 : 0;
    },
    async fillComposer(value) {
      const composer = (await ownedPage()).locator(COMPOSER_SELECTOR);
      if (await composer.count() !== 1) throw new Error("composer unavailable");
      await composer.fill(value);
    },
    async sendPrompt() {
      const owned = await ownedPage();
      const primary = owned.locator('button[data-testid="send-button"]');
      const primaryCount = await primary.count();
      if (primaryCount > 1) throw new Error("send control ambiguous");
      if (primaryCount === 1) { await primary.click(); return; }
      const semantic = owned.locator('button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]');
      if (await semantic.count() !== 1) throw new Error("send control unavailable or ambiguous");
      await semantic.click();
    },
    async assistantMessageCount() { return (await ownedPage()).locator(ASSISTANT_SELECTOR).count(); },
    async latestAssistantText() {
      const assistant = (await ownedPage()).locator(ASSISTANT_SELECTOR);
      return await assistant.count() > 0 ? assistant.last().innerText() : null;
    },
    async latestAssistantRawText() {
      const owned = await ownedPage();
      const assistant = owned.locator(ASSISTANT_SELECTOR);
      if (await assistant.count() === 0) return null;
      const turn = assistant.last().locator('xpath=ancestor::*[.//button[@data-testid="copy-turn-action-button"]][1]');
      if (await turn.count() !== 1) throw new Error("assistant turn copy control unavailable or ambiguous");
      const copy = turn.locator(COPY_SELECTOR);
      if (await copy.count() !== 1) throw new Error("assistant copy control unavailable or ambiguous");
      await owned.evaluate(INSTALL_CLIPBOARD_CAPTURE_SCRIPT);
      try {
        await copy.dispatchEvent("click");
        await owned.waitForFunction(WAIT_CLIPBOARD_CAPTURE_SCRIPT, undefined, { timeout: COPY_CAPTURE_TIMEOUT_MS });
        return await owned.evaluate(READ_CLIPBOARD_CAPTURE_SCRIPT);
      } finally {
        await owned.evaluate(RESTORE_CLIPBOARD_CAPTURE_SCRIPT);
      }
    },
    async generationControlCount() { return (await ownedPage()).locator(GENERATING_SELECTOR).count(); },
    async closeOwnedPage() {
      if (disposed || !page || page.isClosed()) return;
      await page.close();
      page = null;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      page = null;
      await context.close();
    },
  };
}
