import { chromium } from "playwright-core";
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
}

const COMPOSER_SELECTOR = 'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"]';
const AUTH_SELECTOR = 'a[href*="/auth/login"], a[href*="/auth/signup"], a[href*="/auth/sign-up"]';
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
const GENERATING_SELECTOR = 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label="Stop"]';

export async function createPlaywrightBrowserBackend(
  config: Extract<PlaywrightBrowserDriverConfig, { enabled: true }>,
): Promise<PlaywrightBrowserBackend> {
  const context = await chromium.launchPersistentContext(config.profileRoot, {
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    headless: config.headless,
  });
  const page = await context.newPage();

  return {
    async navigate(url) { await page.goto(url, { waitUntil: "domcontentloaded" }); },
    async currentUrl() { return page.url(); },
    async composerCount() { return page.locator(COMPOSER_SELECTOR).count(); },
    async authenticationRequiredCount() { return page.locator(AUTH_SELECTOR).count(); },
    async fillComposer(value) {
      const composer = page.locator(COMPOSER_SELECTOR);
      if (await composer.count() !== 1) throw new Error("composer unavailable");
      await composer.fill(value);
    },
    async sendPrompt() {
      const primary = page.locator('button[data-testid="send-button"]');
      const primaryCount = await primary.count();
      if (primaryCount > 1) throw new Error("send control ambiguous");
      if (primaryCount === 1) { await primary.click(); return; }
      const semantic = page.locator('button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]');
      if (await semantic.count() !== 1) throw new Error("send control unavailable or ambiguous");
      await semantic.click();
    },
    async assistantMessageCount() { return page.locator(ASSISTANT_SELECTOR).count(); },
    async latestAssistantText() {
      const assistant = page.locator(ASSISTANT_SELECTOR);
      return await assistant.count() > 0 ? assistant.last().innerText() : null;
    },
    async generationControlCount() { return page.locator(GENERATING_SELECTOR).count(); },
    async closeOwnedPage() { if (!page.isClosed()) await page.close(); },
  };
}
