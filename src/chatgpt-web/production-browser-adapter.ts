import type { ChatGptWebBrowserAdapter, ChatGptWebSessionProbe } from "./browser-adapter.js";
import { ChatGptWebAuthenticationRequiredError, ChatGptWebSessionLostError } from "./browser-adapter.js";
import type { CompiledWebPrompt } from "./prompt-compiler.js";

export interface ChatGptBrowserDriver {
  openOrResumeConversation(input: { conversationRef?: string; prompt: string; promptSha256: string }): Promise<{ conversationRef: string }>;
  submitPrompt(input: { conversationRef: string; prompt: string; promptSha256: string }): Promise<void>;
  readStructuredResult(input: { conversationRef: string; timeoutMs: number }): Promise<unknown>;
  probeConversation(conversationRef: string): Promise<ChatGptWebSessionProbe>;
  closeConversation(conversationRef: string): Promise<void>;
}

function safeRef(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value)) throw new ChatGptWebSessionLostError("Browser returned an unsafe conversation reference");
  return value;
}
function requireRef(value?: string): string {
  if (!value) throw new ChatGptWebSessionLostError("ChatGPT Web conversation reference is unavailable");
  return safeRef(value);
}
function classify(error: unknown): never {
  if (error instanceof ChatGptWebAuthenticationRequiredError || error instanceof ChatGptWebSessionLostError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/auth|login|sign.?in/i.test(message)) throw new ChatGptWebAuthenticationRequiredError(message);
  throw new ChatGptWebSessionLostError(message);
}

export function createProductionChatGptWebAdapter(driver: ChatGptBrowserDriver): ChatGptWebBrowserAdapter {
  const promptInput = (prompt: CompiledWebPrompt) => ({ prompt: prompt.body, promptSha256: prompt.sha256 });
  return {
    async openOrResumeSession(session, prompt) {
      try {
        const result = await driver.openOrResumeConversation({
          ...(session.conversationRef ? { conversationRef: safeRef(session.conversationRef) } : {}),
          ...promptInput(prompt),
        });
        return { conversationRef: safeRef(result.conversationRef) };
      } catch (error) { return classify(error); }
    },
    async submitTurn(session, prompt) {
      try { await driver.submitPrompt({ conversationRef: requireRef(session.conversationRef), ...promptInput(prompt) }); }
      catch (error) { classify(error); }
    },
    async awaitStructuredResult(session, timeoutMs) {
      try { return await driver.readStructuredResult({ conversationRef: requireRef(session.conversationRef), timeoutMs }); }
      catch (error) { return classify(error); }
    },
    async probeSession(session) {
      try { return await driver.probeConversation(requireRef(session.conversationRef)); }
      catch (error) { return classify(error); }
    },
    async closeSession(session) {
      if (!session.conversationRef) return;
      try { await driver.closeConversation(safeRef(session.conversationRef)); }
      catch (error) { classify(error); }
    },
  };
}
