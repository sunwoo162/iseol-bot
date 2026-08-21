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
  discordGuildId: required("DISCORD_GUILD_ID"),
  githubToken: required("GITHUB_TOKEN"),
  figmaToken: required("FIGMA_TOKEN"),
  notionToken: required("NOTION_TOKEN"),
  saraminApiKey: optional("SARAMIN_API_KEY"),
  work24ApiKey: optional("WORK24_API_KEY"),
  jobkoreaApiUrl: optional("JOBKOREA_API_URL"),
  jobkoreaApiKey: optional("JOBKOREA_API_KEY"),
  figmaWebhookPasscode: optional("FIGMA_WEBHOOK_PASSCODE"),
  publicBaseUrl: optional("PUBLIC_BASE_URL"),
};
