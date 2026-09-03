import assert from "node:assert/strict";
import test from "node:test";

process.env.DISCORD_TOKEN = "discord";
process.env.DISCORD_CLIENT_ID = "client";
process.env.GITHUB_TOKEN = "github";
process.env.FIGMA_TOKEN = "figma";
process.env.NOTION_TOKEN = "notion";
process.env.GOOGLE_CLIENT_ID = "";
process.env.GOOGLE_CLIENT_SECRET = "";
process.env.GOOGLE_REFRESH_TOKEN = "";
process.env.GOOGLE_REDIRECT_URI = "";
process.env.GEMINI_API_KEY = "";
process.env.GITHUB_WEBHOOK_SECRET = "";

const { config } = await import("../src/config.js");

test("optional calendar and review secrets default to empty strings", () => {
  assert.equal(config.googleClientId, "");
  assert.equal(config.googleClientSecret, "");
  assert.equal(config.googleRefreshToken, "");
  assert.equal(config.googleRedirectUri, "");
  assert.equal(config.geminiApiKey, "");
  assert.equal(config.githubWebhookSecret, "");
});
