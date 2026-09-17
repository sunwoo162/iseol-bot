import type { ChatGptWebBrowserAdapter, ChatGptWebSessionProbe } from "./browser-adapter.js";
import {
  ChatGptWebAuthenticationRequiredError,
  ChatGptWebSessionLostError,
  ChatGptWebTemporarilyLimitedError,
  ChatGptWebConversationLimitError,
  ChatGptWebUsageLimitError,
  ChatGptWebStructuredResultError,
} from "./browser-adapter.js";
import type { CompiledWebPrompt } from "./prompt-compiler.js";

export interface ChatGptBrowserDriver {
  openOrResumeConversation(input: { conversationRef?: string; prompt: string; promptSha256: string }): Promise<{ conversationRef?: string }>;
  submitPrompt(input: { conversationRef?: string; prompt: string; promptSha256: string }): Promise<{ conversationRef?: string } | void>;
  readStructuredResult(input: { conversationRef: string; timeoutMs: number }): Promise<unknown>;
  probeConversation(conversationRef: string): Promise<ChatGptWebSessionProbe>;
  closeConversation(conversationRef: string): Promise<void>;
  recordParserDiagnostic?(input: { stage: string; sessionId: string; generation: number; conversationRef?: string; message: string; diagnostic?: Record<string, string | boolean> }): Promise<void>;
  recordOperationDiagnostic?(input: { operation: string; phase: "failure"; stage: string; sessionId: string; generation: number; conversationRef?: string; failureClass: string }): Promise<void>;
  dispose?(): Promise<void>;
}

function safeRef(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) {
    throw new ChatGptWebSessionLostError("Browser returned an unsafe conversation reference");
  }
  return value;
}
function requireRef(value?: string): string {
  if (!value) throw new ChatGptWebSessionLostError("ChatGPT Web conversation reference is unavailable");
  return safeRef(value);
}
function classify(error: unknown): never {
  if (
    error instanceof ChatGptWebAuthenticationRequiredError
    || error instanceof ChatGptWebSessionLostError
    || error instanceof ChatGptWebTemporarilyLimitedError
    || error instanceof ChatGptWebConversationLimitError
    || error instanceof ChatGptWebUsageLimitError
    || error instanceof ChatGptWebStructuredResultError
  ) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|login|sign.?in/i.test(message)) throw new ChatGptWebAuthenticationRequiredError(message);
  throw new ChatGptWebSessionLostError(message);
}

export function createProductionChatGptWebAdapter(driver: ChatGptBrowserDriver): ChatGptWebBrowserAdapter {
  const recordFailure = async (operation: string, session: any, error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown";
    const failureClass = error instanceof ChatGptWebStructuredResultError ? "structured-result-parser-rejection" : /conversation identity/i.test(message) ? "conversation-identity-failure" : /composer/i.test(message) ? "composer-failure" : /assistant/i.test(message) ? "assistant-response-failure" : /timeout/i.test(message) ? "response-timeout" : "browser-operation-unknown";
    await driver.recordOperationDiagnostic?.({ operation, phase: "failure", stage: session.stage, sessionId: session.sessionId, generation: session.generation, ...(session.conversationRef ? { conversationRef: session.conversationRef } : {}), failureClass }).catch(() => undefined);
  };
  const promptInput = (prompt: CompiledWebPrompt) => ({ prompt: prompt.body, promptSha256: prompt.sha256 });
  return {
    async openOrResumeSession(session, prompt) {
      try {
        const result = await driver.openOrResumeConversation({
          ...(session.conversationRef ? { conversationRef: safeRef(session.conversationRef) } : {}),
          ...promptInput(prompt),
        });
        return result.conversationRef ? { conversationRef: safeRef(result.conversationRef) } : {};
      } catch (error) { await recordFailure(session.conversationRef ? "reacquire-owned-page" : "acquire-owned-page", session, error); return classify(error); }
    },
    async submitTurn(session, prompt) {
      try {
        const result = await driver.submitPrompt({
          ...(session.conversationRef ? { conversationRef: safeRef(session.conversationRef) } : {}),
          ...promptInput(prompt),
        });
        return result?.conversationRef ? { conversationRef: safeRef(result.conversationRef) } : {};
      } catch (error) { await recordFailure("submit-prompt", session, error); return classify(error); }
    },
    async awaitStructuredResult(session, timeoutMs) {
      try { return await driver.readStructuredResult({ conversationRef: requireRef(session.conversationRef), timeoutMs }); }
      catch (error) { await recordFailure("extract-structured-result", session, error); if (error instanceof ChatGptWebStructuredResultError) await driver.recordParserDiagnostic?.({ stage: session.stage, sessionId: session.sessionId, generation: session.generation, ...(session.conversationRef ? { conversationRef: session.conversationRef } : {}), message: error.message, diagnostic: error.diagnostic }); return classify(error); }
    },
    async probeSession(session) {
      try { return await driver.probeConversation(requireRef(session.conversationRef)); }
      catch (error) { await recordFailure("inspect-page-state", session, error); return classify(error); }
    },
    async closeSession(session) {
      if (!session.conversationRef) return;
      try { await driver.closeConversation(safeRef(session.conversationRef)); }
      catch (error) { classify(error); }
    },
  };
}
