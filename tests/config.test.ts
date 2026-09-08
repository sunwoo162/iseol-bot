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
process.env.ISEOL_WEB_HOST = "";
process.env.ISEOL_WEB_PORT = "";
process.env.ISEOL_WEB_TOKEN = "";
process.env.ISEOL_MODEL_ROOT = "";
process.env.ISEOL_RUN_ROOT = "";
process.env.ISEOL_CHATGPT_WEB_ENABLED = "";
process.env.ISEOL_CHATGPT_WEB_ROOT = "";

const { config } = await import("../src/config.js");

test("optional calendar review web and chatgpt bridge settings default to empty strings", () => {
  assert.equal(config.googleClientId, "");
  assert.equal(config.googleClientSecret, "");
  assert.equal(config.googleRefreshToken, "");
  assert.equal(config.googleRedirectUri, "");
  assert.equal(config.geminiApiKey, "");
  assert.equal(config.githubWebhookSecret, "");
  assert.equal(config.iseolWebHost, "");
  assert.equal(config.iseolWebPort, "");
  assert.equal(config.iseolWebToken, "");
  assert.equal(config.iseolModelRoot, "");
  assert.equal(config.iseolRunRoot, "");
  assert.equal(config.iseolChatGptWebEnabled, "");
  assert.equal(config.iseolChatGptWebRoot, "");
});
