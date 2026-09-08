import { chromium } from "playwright-core";
import type { PlaywrightBrowserDriverConfig } from "./playwright-browser-config.js";

export interface PlaywrightBrowserBackend {
  navigate(url: string): Promise<void>;
  currentUrl(): Promise<string>;
  composerCount(): Promise<number>;
  authenticationRequiredCount(): Promise<number>;
  closeOwnedPage(): Promise<void>;
}

export async function createPlaywrightBrowserBackend(
  config: Extract<PlaywrightBrowserDriverConfig, { enabled: true }>,
): Promise<PlaywrightBrowserBackend> {
  const context = await chromium.launchPersistentContext(config.profileRoot, {
    ...(config.executablePath ? { executablePath: config.executablePath } : {}),
    headless: config.headless,
  });
  const page = await context.newPage();

  return {
    async navigate(url) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    },
    async currentUrl() {
      return page.url();
    },
    async composerCount() {
      return page.locator('textarea, [contenteditable="true"]').count();
    },
    async authenticationRequiredCount() {
      return page.locator('a[href*="/auth/login"], a[href*="/auth/signup"], a[href*="/auth/sign-up"]').count();
    },
    async closeOwnedPage() {
      if (!page.isClosed()) await page.close();
    },
  };
}
