import "dotenv/config";
import { readFileSync } from "node:fs";

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }

  return value;
}

function optional(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function storedGoogleRefreshToken(): string {
  try {
    const parsed = JSON.parse(readFileSync("data/google-oauth.json", "utf8")) as { refreshToken?: unknown };
    return typeof parsed.refreshToken === "string" ? parsed.refreshToken.trim() : "";
  } catch {
    return "";
  }
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: optional("DISCORD_GUILD_ID"),
  githubToken: required("GITHUB_TOKEN"),
  figmaToken: required("FIGMA_TOKEN"),
  notionToken: required("NOTION_TOKEN"),
  figmaWebhookPasscode: optional("FIGMA_WEBHOOK_PASSCODE"),
  publicBaseUrl: optional("PUBLIC_BASE_URL"),
  googleClientId: optional("GOOGLE_CLIENT_ID"),
  googleClientSecret: optional("GOOGLE_CLIENT_SECRET"),
  googleRefreshToken: optional("GOOGLE_REFRESH_TOKEN") || storedGoogleRefreshToken(),
  googleRedirectUri: optional("GOOGLE_REDIRECT_URI"),
  geminiApiKey: optional("GEMINI_API_KEY"),
  githubWebhookSecret: optional("GITHUB_WEBHOOK_SECRET"),
};
