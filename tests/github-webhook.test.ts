import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { shouldReviewPullRequestAction, verifyGitHubSignature } from "../src/services/github-webhook.js";
import {
  buildAutomationWebhookUrl,
  discordGitHubWebhookTarget,
  findExistingWebhookId,
} from "../src/services/github.js";

test("github webhook signature verification uses sha256 hmac", () => {
  const body = Buffer.from('{"ok":true}');
  const signature = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`;
  assert.equal(verifyGitHubSignature("secret", body, signature), true);
  assert.equal(verifyGitHubSignature("wrong", body, signature), false);
});

test("only opened reopened and synchronize pull request actions trigger review", () => {
  assert.equal(shouldReviewPullRequestAction("opened"), true);
  assert.equal(shouldReviewPullRequestAction("reopened"), true);
  assert.equal(shouldReviewPullRequestAction("synchronize"), true);
  assert.equal(shouldReviewPullRequestAction("closed"), false);
});

test("automation webhook url targets the signed github events endpoint", () => {
  assert.equal(buildAutomationWebhookUrl("https://iseol.example.com/"), "https://iseol.example.com/github/events");
});

test("discord github webhook target is stable and existing target is reused", () => {
  const target = discordGitHubWebhookTarget("https://discord.com/api/webhooks/1/token/");
  assert.equal(target, "https://discord.com/api/webhooks/1/token/github");
  assert.equal(findExistingWebhookId([
    { id: 10, url: "https://example.com/hook" },
    { id: 11, url: target },
  ], target), 11);
  assert.equal(findExistingWebhookId([{ id: 12, url: "https://example.com/hook" }], target), null);
});
