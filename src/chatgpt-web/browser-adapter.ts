import type { ReasoningTurnResult, WebWorkerSession } from "./contracts.js";
import type { CompiledWebPrompt } from "./prompt-compiler.js";

export type ChatGptWebSessionProbe = "ready" | "lost" | "auth-required";
export type ChatGptWebOpenResult = { conversationRef?: string };

export class ChatGptWebSessionLostError extends Error {
  constructor(message: string) { super(message); this.name = "ChatGptWebSessionLostError"; }
}
export class ChatGptWebAuthenticationRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "ChatGptWebAuthenticationRequiredError"; }
}

export interface ChatGptWebBrowserAdapter {
  openOrResumeSession(session: WebWorkerSession, prompt: CompiledWebPrompt): Promise<ChatGptWebOpenResult>;
  submitTurn(session: WebWorkerSession, prompt: CompiledWebPrompt): Promise<void>;
  awaitStructuredResult(session: WebWorkerSession, timeoutMs: number): Promise<unknown>;
  probeSession(session: WebWorkerSession): Promise<ChatGptWebSessionProbe>;
  closeSession(session: WebWorkerSession): Promise<void>;
}

export function asReasoningTurnResult(value: unknown): ReasoningTurnResult {
  return value as ReasoningTurnResult;
}
