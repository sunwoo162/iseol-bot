import { ChatGptWebAuthenticationRequiredError, ChatGptWebSessionLostError } from "./browser-adapter.js";
import type { ChatGptWebSessionProbe } from "./browser-adapter.js";
import type { ChatGptBrowserDriver } from "./production-browser-adapter.js";
import type { PlaywrightBrowserDriverConfig } from "./playwright-browser-config.js";
import { createPlaywrightBrowserBackend, type PlaywrightBrowserBackend } from "./playwright-browser-backend.js";

export type { PlaywrightBrowserBackend } from "./playwright-browser-backend.js";

const ROOT = "https://chatgpt.com/";
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function conversationFrom(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://chatgpt.com") return undefined;
    const match = parsed.pathname.match(/^\/c\/([^/]+)\/?$/);
    return match?.[1] && REF.test(match[1]) ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

function isCanonicalNewPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://chatgpt.com" && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}
function authUrl(url: string): boolean {
  return /\/((auth\/)?login|signup|sign-up)(\/|$)/i.test(url);
}

function lost(message: string): never {
  throw new ChatGptWebSessionLostError(message);
}

function classifyBrowserFailure(error: unknown): never {
  if (error instanceof ChatGptWebAuthenticationRequiredError || error instanceof ChatGptWebSessionLostError) throw error;
  throw new ChatGptWebSessionLostError("ChatGPT browser operation failed");
}

export async function createPlaywrightChatGptBrowserDriver(
  config: Extract<PlaywrightBrowserDriverConfig, { enabled: true }>,
  deps?: { backend?: PlaywrightBrowserBackend },
): Promise<ChatGptBrowserDriver> {
  const backend = deps?.backend ?? await createPlaywrightBrowserBackend(config);

  async function openOrResumeConversation(input: { conversationRef?: string; prompt: string; promptSha256: string }) {
    try {
      const requested = input.conversationRef;
      if (requested && !REF.test(requested)) lost("Conversation identity is invalid");
      await backend.navigate(requested ? `${ROOT}c/${requested}` : ROOT);
      const url = await backend.currentUrl();
      const composerCount = await backend.composerCount();
      const authCount = await backend.authenticationRequiredCount();
      if (authUrl(url) || (authCount > 0 && composerCount === 0)) {
        throw new ChatGptWebAuthenticationRequiredError("ChatGPT authentication is required");
      }
      if (composerCount !== 1) lost("Authenticated ChatGPT composer is missing or ambiguous");

      const actual = conversationFrom(url);
      if (requested) {
        if (actual !== requested) lost("ChatGPT conversation identity changed during navigation");
        return { conversationRef: requested };
      }
      if (actual) return { conversationRef: actual };
      if (isCanonicalNewPage(url)) return {};
      return lost("ChatGPT new conversation navigation drifted from the canonical page");
    } catch (error) {
      return classifyBrowserFailure(error);
    }
  }

  return {
    openOrResumeConversation,
    async submitPrompt() { return lost("Prompt submission is not implemented by Task 2"); },
    async readStructuredResult() { return lost("Structured result reading is not implemented by Task 2"); },
    async probeConversation(): Promise<ChatGptWebSessionProbe> { return lost("Conversation probing is not implemented by Task 2"); },
    async closeConversation() { await backend.closeOwnedPage(); },
  };
}
