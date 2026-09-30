import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { shouldReviewPullRequestAction, verifyGitHubSignature } from "../src/services/github-webhook.js";

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

import { buildAutomationWebhookUrl, parseGitHubRepository } from "../src/services/github.js";

test("automation webhook url targets the signed github events endpoint", () => {
  assert.equal(buildAutomationWebhookUrl("https://iseol.example.com/"), "https://iseol.example.com/github/events");
});

test("github repository identities reject malformed and path-like input", () => {
  assert.deepEqual(parseGitHubRepository("openai/iseol"), {
    owner: "openai",
    repo: "iseol",
    url: "https://github.com/openai/iseol",
  });
  assert.deepEqual(parseGitHubRepository("https://github.com/openai/iseol"), {
    owner: "openai",
    repo: "iseol",
    url: "https://github.com/openai/iseol",
  });

  for (const value of [
    "https://github.com/openai/%E0%A4%A",
    "https://github.com/openai/iseol%2Fsecret",
    "https://github.com/openai%2Fsecret/iseol",
    "openai\\iseol",
    "https://github.com/openai/iseol%5Csecret",
    "https://github.com/openai/iseol?redirect=/private",
    "https://github.com/openai/iseol#private",
  ]) {
    assert.throws(() => parseGitHubRepository(value), /GitHub 저장소/);
  }
});
