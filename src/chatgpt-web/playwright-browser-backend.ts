import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { PlaywrightBrowserDriverConfig } from "./playwright-browser-config.js";

export interface PlaywrightBrowserBackend {
  navigate(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  composerCount(): Promise<number>;
  authenticationRequiredCount(): Promise<number>;
  fillComposer(value: string): Promise<void>;
  sendPrompt(): Promise<void>;
  assistantMessageCount(): Promise<number>;
  latestAssistantText(): Promise<string | null>;
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
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
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
