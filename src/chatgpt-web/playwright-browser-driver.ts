import {
  ChatGptWebAuthenticationRequiredError,
  ChatGptWebSessionLostError,
  ChatGptWebStructuredResultError,
} from "./browser-adapter.js";
import type { ChatGptWebSessionProbe } from "./browser-adapter.js";
import type { ChatGptBrowserDriver } from "./production-browser-adapter.js";
import type { PlaywrightBrowserDriverConfig } from "./playwright-browser-config.js";
import { createPlaywrightBrowserBackend, type PlaywrightBrowserBackend } from "./playwright-browser-backend.js";

export type { PlaywrightBrowserBackend } from "./playwright-browser-backend.js";

const ROOT = "https://chatgpt.com/";
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const POLL_MS = 100;
const RESULT_SETTLE_MS = 750;
const NEW_CONVERSATION_REF_TIMEOUT_MS = 5_000;
const COMPOSER_READY_TIMEOUT_MS = 5_000;
const MAX_STRUCTURED_RESULT_BYTES = 262_144;

type DriverDeps = {
  backend?: PlaywrightBrowserBackend;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

function conversationFrom(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== "https://chatgpt.com") return undefined;
    const match = parsed.pathname.match(/^\/c\/([^/]+)\/?$/);
    return match?.[1] && REF.test(match[1]) ? match[1] : undefined;
  } catch { return undefined; }
}

function isCanonicalNewPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://chatgpt.com" && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch { return false; }
}
function authUrl(url: string): boolean {
  return /\/((auth\/)?login|signup|sign-up)(\/|$)/i.test(url);
}
function lost(message: string): never { throw new ChatGptWebSessionLostError(message); }
function structured(message: string): never { throw new ChatGptWebStructuredResultError(message); }

function classifyBrowserFailure(error: unknown): never {
  if (
    error instanceof ChatGptWebAuthenticationRequiredError
    || error instanceof ChatGptWebSessionLostError
    || error instanceof ChatGptWebStructuredResultError
  ) throw error;
  throw new ChatGptWebSessionLostError("ChatGPT browser operation failed");
}

function parseStructuredResult(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_STRUCTURED_RESULT_BYTES) {
    structured("ChatGPT structured result exceeds the allowed size");
  }
  const trimmed = text.trim();
  if (!trimmed) structured("ChatGPT structured result is empty");
  let candidate = trimmed;
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) candidate = fenced[1]?.trim() ?? "";
  else if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    structured("ChatGPT structured result fence is malformed");
  }
  try { return JSON.parse(candidate); }
  catch { return structured("ChatGPT structured result is not exactly one JSON value"); }
}

export async function createPlaywrightChatGptBrowserDriver(
  config: Extract<PlaywrightBrowserDriverConfig, { enabled: true }>,
  deps?: DriverDeps,
): Promise<ChatGptBrowserDriver> {
  const backend = deps?.backend ?? await createPlaywrightBrowserBackend(config);
  const now = deps?.now ?? (() => Date.now());
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const submittedByTurn = new Map<string, string | undefined>();
  const inFlightByTurn = new Map<string, Promise<{ conversationRef?: string }>>();
  const pendingByConversation = new Map<string, { baselineAssistantCount: number }>();
  const turnKey = (conversationRef: string | undefined, sha: string) => JSON.stringify([conversationRef ?? null, sha]);

  async function authenticatedComposerCount(url: string): Promise<number> {
    const composerCount = await backend.composerCount();
    const authCount = await backend.authenticationRequiredCount();
    if (authUrl(url) || authCount > 0) {
      throw new ChatGptWebAuthenticationRequiredError("ChatGPT authentication is required");
    }
    return composerCount;
  }

  async function waitForAuthenticatedComposer(): Promise<string> {
    const startedAt = now();
    while (true) {
      const url = await backend.currentUrl();
      const composerCount = await authenticatedComposerCount(url);
      if (composerCount === 1) return url;
      if (composerCount > 1) lost("Authenticated ChatGPT composer is missing or ambiguous");
      if (now() - startedAt >= COMPOSER_READY_TIMEOUT_MS) {
        lost("Authenticated ChatGPT composer is missing or ambiguous");
      }
      await sleep(POLL_MS);
    }
  }

  async function waitForNewConversationRef(): Promise<string> {
    const startedAt = now();
    while (true) {
      const url = await backend.currentUrl();
      if (authUrl(url)) throw new ChatGptWebAuthenticationRequiredError("ChatGPT authentication is required");
      const actual = conversationFrom(url);
      if (actual && !actual.startsWith("WEB:")) return actual;
      if (now() - startedAt >= NEW_CONVERSATION_REF_TIMEOUT_MS) {
        return lost("ChatGPT did not assign a canonical conversation identity after prompt submission");
      }
      await sleep(POLL_MS);
    }
  }

  async function openOrResumeConversation(input: { conversationRef?: string; prompt: string; promptSha256: string }) {
    try {
      const requested = input.conversationRef;
      if (requested && !REF.test(requested)) lost("Conversation identity is invalid");
      await backend.navigate(requested ? `${ROOT}c/${requested}` : ROOT);
      const url = await waitForAuthenticatedComposer();
      const actual = conversationFrom(url);
      if (requested) {
        if (actual !== requested) lost("ChatGPT conversation identity changed during navigation");
        return { conversationRef: requested };
      }
      if (actual) return { conversationRef: actual };
      if (isCanonicalNewPage(url)) return {};
      return lost("ChatGPT new conversation navigation drifted from the canonical page");
    } catch (error) { return classifyBrowserFailure(error); }
  }

  async function submitPrompt(input: { conversationRef?: string; prompt: string; promptSha256: string }) {
    if (!input.promptSha256) lost("Prompt identity is unavailable");
    const key = turnKey(input.conversationRef, input.promptSha256);
    if (submittedByTurn.has(key)) {
      const previous = submittedByTurn.get(key);
      return previous ? { conversationRef: previous } : {};
    }
    const existing = inFlightByTurn.get(key);
    if (existing) return existing;

    const operation = (async (): Promise<{ conversationRef?: string }> => {
      try {
        const beforeUrl = await backend.currentUrl();
        if (input.conversationRef) {
          if (!REF.test(input.conversationRef) || conversationFrom(beforeUrl) !== input.conversationRef) {
            lost("ChatGPT conversation identity changed before prompt submission");
          }
        } else if (!isCanonicalNewPage(beforeUrl)) {
          lost("ChatGPT new conversation identity is unavailable before prompt submission");
        }
        if (await authenticatedComposerCount(beforeUrl) !== 1) lost("Authenticated ChatGPT composer is missing or ambiguous");
        const baselineAssistantCount = await backend.assistantMessageCount();
        await backend.fillComposer(input.prompt);
        await backend.sendPrompt();

        const actual = input.conversationRef ?? await waitForNewConversationRef();
        if (conversationFrom(await backend.currentUrl()) !== actual) {
          lost("ChatGPT conversation identity changed after prompt submission");
        }
        submittedByTurn.set(key, actual);
        submittedByTurn.set(turnKey(actual, input.promptSha256), actual);
        pendingByConversation.set(actual, { baselineAssistantCount });
        return { conversationRef: actual };
      } catch (error) { return classifyBrowserFailure(error); }
    })();

    inFlightByTurn.set(key, operation);
    operation.then(
      () => { inFlightByTurn.delete(key); },
      () => { inFlightByTurn.delete(key); },
    );
    return operation;
  }

  async function readStructuredResult(input: { conversationRef: string; timeoutMs: number }): Promise<unknown> {
    try {
      if (!REF.test(input.conversationRef)) lost("Conversation identity is invalid");
      if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) lost("Structured result timeout is invalid");
      const startedAt = now();
      const pending = pendingByConversation.get(input.conversationRef);
      if (!pending) lost("No pending ChatGPT submission is available for structured result reading");
      const baseline = pending.baselineAssistantCount;
      let stableText: string | null = null;
      let stableSince = startedAt;

      while (true) {
        const url = await backend.currentUrl();
        if (conversationFrom(url) !== input.conversationRef) lost("ChatGPT conversation identity changed while reading result");
        if (await authenticatedComposerCount(url) !== 1) lost("Authenticated ChatGPT composer is missing or ambiguous");
        const assistantCount = await backend.assistantMessageCount();
        const generatingCount = await backend.generationControlCount();
        const latestText = assistantCount > baseline ? await backend.latestAssistantText() : null;

        if (generatingCount === 0 && latestText?.trim()) {
          if (latestText === stableText) {
            if (now() - stableSince >= RESULT_SETTLE_MS) {
              pendingByConversation.delete(input.conversationRef);
              return parseStructuredResult(latestText);
            }
          } else {
            stableText = latestText;
            stableSince = now();
          }
        } else {
          stableText = null;
          stableSince = now();
        }

        const elapsed = now() - startedAt;
        if (elapsed >= input.timeoutMs) lost("ChatGPT structured result timed out");
        await sleep(Math.min(POLL_MS, Math.max(1, input.timeoutMs - elapsed)));
      }
    } catch (error) { return classifyBrowserFailure(error); }
  }

  async function probeConversation(conversationRef: string): Promise<ChatGptWebSessionProbe> {
    if (!REF.test(conversationRef)) return "lost";
    try {
      const url = await backend.currentUrl();
      const composerCount = await backend.composerCount();
      const authCount = await backend.authenticationRequiredCount();
      if (authUrl(url) || authCount > 0) return "auth-required";
      if (conversationFrom(url) !== conversationRef || composerCount !== 1) return "lost";
      return "ready";
    } catch { return "lost"; }
  }

  return {
    openOrResumeConversation,
    submitPrompt,
    readStructuredResult,
    probeConversation,
    async closeConversation(conversationRef) {
      if (!REF.test(conversationRef)) lost("Conversation identity is invalid");
      await backend.closeOwnedPage();
      pendingByConversation.delete(conversationRef);
      for (const [key, submittedConversationRef] of submittedByTurn) {
        if (submittedConversationRef === conversationRef) submittedByTurn.delete(key);
      }
    },
    async dispose() { await backend.dispose(); },
  };
}
