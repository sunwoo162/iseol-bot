import "dotenv/config";

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
  googleRefreshToken: optional("GOOGLE_REFRESH_TOKEN"),
  googleRedirectUri: optional("GOOGLE_REDIRECT_URI"),
  geminiApiKey: optional("GEMINI_API_KEY"),
  githubWebhookSecret: optional("GITHUB_WEBHOOK_SECRET"),
  iseolWebHost: optional("ISEOL_WEB_HOST"),
  iseolWebPort: optional("ISEOL_WEB_PORT"),
  iseolWebToken: optional("ISEOL_WEB_TOKEN"),
  iseolModelRoot: optional("ISEOL_MODEL_ROOT"),
  iseolRunRoot: optional("ISEOL_RUN_ROOT"),
  iseolDesktopAgentHost: optional("ISEOL_DESKTOP_AGENT_HOST"),
  iseolDesktopAgentPort: optional("ISEOL_DESKTOP_AGENT_PORT"),
  iseolDesktopAgentToken: optional("ISEOL_DESKTOP_AGENT_TOKEN"),
  iseolDesktopAgentRoot: optional("ISEOL_DESKTOP_AGENT_ROOT"),
};
