import type { ChatGptWebBrowserAdapter } from "./browser-adapter.js";
import { createProductionChatGptWebAdapter, type ChatGptBrowserDriver } from "./production-browser-adapter.js";

export type ChatGptWebBridgeConfig = {
  enabled: boolean;
  workerRoot: string;
};

export function resolveChatGptWebBridgeConfig(env: Record<string, string | undefined>): ChatGptWebBridgeConfig {
  const raw = env.ISEOL_CHATGPT_WEB_ENABLED?.trim().toLowerCase() ?? "";
  if (raw && raw !== "true" && raw !== "false") throw new Error("ISEOL_CHATGPT_WEB_ENABLED must be true or false");
  return {
    enabled: raw === "true",
    workerRoot: env.ISEOL_CHATGPT_WEB_ROOT?.trim() || "data/runs",
  };
}

export type ChatGptWebBridgeService =
  | { enabled: false }
  | { enabled: true; workerRoot: string; adapter: ChatGptWebBrowserAdapter };

export async function startChatGptWebBridgeService(
  config: ChatGptWebBridgeConfig,
  driver?: ChatGptBrowserDriver,
): Promise<ChatGptWebBridgeService> {
  if (!config.enabled) return { enabled: false };
  if (!driver) throw new Error("ChatGPT Web browser driver is required when the bridge is enabled");
  return { enabled: true, workerRoot: config.workerRoot, adapter: createProductionChatGptWebAdapter(driver) };
}
