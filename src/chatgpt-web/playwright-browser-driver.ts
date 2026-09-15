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
const NEW_CONVERSATION_REF_TIMEOUT_MS = 30_000;
const COMPOSER_READY_TIMEOUT_MS = 15_000;
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

function canonicalizeNewFilePatch(patch: string): string {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) lines.pop();
  if (lines.filter((line) => line.startsWith("--- ")).length !== 1 || !lines.includes("--- /dev/null")) return patch;
  const hunkIndexes = lines.flatMap((line, index) => line.startsWith("@@ ") ? [index] : []);
  if (hunkIndexes.length !== 1) return patch;
  const hunkIndex = hunkIndexes[0]!;
  const match = lines[hunkIndex]!.match(/^@@ -0,0 \+(\d+)(?:,\d+)? @@(.*)$/);
  if (!match) return patch;
  let newCount = 0;
  for (let index = hunkIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "\\ No newline at end of file") continue;
    if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@ ")) return patch;
    if (line.startsWith(" ") || line.startsWith("-")) return patch;
    if (!line.startsWith("+")) lines[index] = `+${line}`;
    newCount += 1;
  }
  lines[hunkIndex] = `@@ -0,0 +${match[1]},${newCount} @@${match[2] ?? ""}`;
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function canonicalizeHunkBlankLineNoise(patch: string): string {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) lines.pop();
  const output: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ "))) inHunk = false;
    if (inHunk && line === "") continue;
    output.push(line);
  }
  return output.join("\n") + (trailingNewline ? "\n" : "");
}

function validatePatchAppendixSyntax(patch: string): void {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const diffHeaders = lines.filter((line) => line.startsWith("diff --git "));
  const oldHeaders = lines.filter((line) => line.startsWith("--- "));
  const newHeaders = lines.filter((line) => line.startsWith("+++ "));
  if (diffHeaders.length !== 1 || oldHeaders.length !== 1 || newHeaders.length !== 1) {
    structured("ChatGPT patch appendix must contain exactly one file diff");
  }
  let hunks = 0;
  let index = 0;
  while (index < lines.length) {
    const header = lines[index]!;
    if (!header.startsWith("@@ ")) { index += 1; continue; }
    const match = header.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/);
    if (!match) structured("ChatGPT patch hunk header is invalid");
    const expectedOld = match[1] === undefined ? 1 : Number.parseInt(match[1], 10);
    const expectedNew = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    let seenOld = 0;
    let seenNew = 0;
    hunks += 1;
    index += 1;
    while (index < lines.length && !lines[index]!.startsWith("@@ ")) {
      const line = lines[index]!;
      if (line === "\\ No newline at end of file") { index += 1; continue; }
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
        structured("ChatGPT patch appendix must contain exactly one file diff");
      }
      const prefix = line[0];
      if (prefix === " ") { seenOld += 1; seenNew += 1; }
      else if (prefix === "-") seenOld += 1;
      else if (prefix === "+") seenNew += 1;
      else structured("ChatGPT patch hunk body lines require a unified-diff prefix");
      index += 1;
    }
    if (seenOld !== expectedOld || seenNew !== expectedNew) {
      structured("ChatGPT patch hunk line counts do not match the hunk header");
    }
  }
  if (hunks === 0) structured("ChatGPT patch appendix must include at least one hunk");
}

function parsePatchMultipart(candidate: string): unknown | null {
  const firstNewline = candidate.indexOf("\n");
  if (firstNewline < 0) return null;
  const headerText = candidate.slice(0, firstNewline).trim();
  let header: any;
  try { header = JSON.parse(headerText); } catch { return null; }
  if (!header || typeof header !== "object" || Array.isArray(header)) structured("ChatGPT patch header must be one JSON object");
  let rest = candidate.slice(firstNewline + 1).replaceAll("\r\n", "\n");
  const blocks = new Map<string, string>();
  while (rest.trim()) {
    if (rest.startsWith("\n")) rest = rest.slice(1);
    const begin = rest.match(/^@@ISEOL_PATCH_BEGIN:([A-Za-z0-9][A-Za-z0-9._:-]{0,191})@@\n/);
    if (!begin?.[1]) structured("ChatGPT patch appendix begin marker is invalid");
    const id = begin[1];
    if (blocks.has(id)) structured("ChatGPT patch appendix id is duplicated");
    const bodyStart = begin[0].length;
    const endMarker = `\n@@ISEOL_PATCH_END:${id}@@`;
    const endAt = rest.indexOf(endMarker, bodyStart);
    if (endAt < 0) structured("ChatGPT patch appendix end marker is missing");
    blocks.set(id, rest.slice(bodyStart, endAt) + "\n");
    rest = rest.slice(endAt + endMarker.length);
  }
  const intents = Array.isArray(header.intents) ? header.intents : [];
  const used = new Set<string>();
  for (const intent of intents) {
    if (!intent || intent.kind !== "PROPOSE_PATCH") continue;
    const id = typeof intent.intentId === "string" ? intent.intentId : "";
    if (intent.patch !== `@@ISEOL_PATCH:${id}@@`) structured("ChatGPT patch placeholder does not match intent identity");
    const patch = blocks.get(id);
    if (patch === undefined) structured("ChatGPT patch appendix is missing");
    const canonicalPatch = canonicalizeHunkBlankLineNoise(canonicalizeNewFilePatch(patch));
    validatePatchAppendixSyntax(canonicalPatch);
    intent.patch = canonicalPatch;
    used.add(id);
  }
  if (blocks.size !== used.size) structured("ChatGPT patch appendix is not referenced by a PROPOSE_PATCH intent");
  return header;
}
function parseStructuredResult(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_STRUCTURED_RESULT_BYTES) structured("ChatGPT structured result exceeds the allowed size");
  const trimmed = text.trim();
  if (!trimmed) structured("ChatGPT structured result is empty");
  let candidate = trimmed;
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenced) candidate = fenced[1]?.trim() ?? "";
  else if (trimmed.startsWith("```") || trimmed.endsWith("```")) structured("ChatGPT structured result fence is malformed");
  const multipart = parsePatchMultipart(candidate);
  if (multipart !== null) return multipart;
  try {
    const parsed = JSON.parse(candidate);
    const intents = parsed && typeof parsed === "object" && Array.isArray((parsed as any).intents) ? (parsed as any).intents : [];
    if (intents.some((intent: any) => intent?.kind === "PROPOSE_PATCH")) structured("ChatGPT PROPOSE_PATCH requires raw patch appendix transport");
    return parsed;
  } catch (error) {
    if (error instanceof ChatGptWebStructuredResultError) throw error;
    return structured("ChatGPT structured result is not exactly one JSON value");
  }
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
              const rawText = await backend.latestAssistantRawText();
              if (!rawText?.trim()) lost("ChatGPT assistant source is unavailable");
              pendingByConversation.delete(input.conversationRef);
              return parseStructuredResult(rawText);
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
