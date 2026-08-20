import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} 환경변수가 필요합니다.`);
  }

  return value;
}

function port(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} 환경변수는 1~65535 사이의 포트 번호여야 합니다.`);
  }

  return value;
}

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  discordClientId: required("DISCORD_CLIENT_ID"),
  discordGuildId: required("DISCORD_GUILD_ID"),
  githubToken: required("GITHUB_TOKEN"),
  figmaToken: required("FIGMA_TOKEN"),
  figmaWebhookPasscode: required("FIGMA_WEBHOOK_PASSCODE"),
  publicBaseUrl: required("PUBLIC_BASE_URL"),
  webhookPort: port("PORT", 3000),
};
