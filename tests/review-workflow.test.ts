import assert from "node:assert/strict";
import test from "node:test";
import { ISEOL_REVIEW_WORKFLOW_PATH, renderIseolReviewWorkflow } from "../src/services/review/review-workflow.js";

test("review workflow is self-hosted, fork-safe, and uploads the normalized artifact", () => {
  const yaml = renderIseolReviewWorkflow("abc123");
  assert.equal(ISEOL_REVIEW_WORKFLOW_PATH, ".github/workflows/iseol-code-review.yml");
  assert.match(yaml, /name: Iseol Code Review/);
  assert.match(yaml, /pull_request:/);
  assert.match(yaml, /types: \[opened, reopened, synchronize\]/);
  assert.match(yaml, /runs-on: \[self-hosted, linux, x64, iseol-review\]/);
  assert.match(yaml, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(yaml, /contents: read/);
  assert.doesNotMatch(yaml, /contents: write/);
  assert.match(yaml, /sunwoo162\/iseol-bot\/abc123\/scripts\/iseol-review-collector\.mjs/);
  assert.match(yaml, /ISEOL_PR_NUMBER:/);
  assert.match(yaml, /ISEOL_HEAD_SHA:/);
  assert.match(yaml, /name: iseol-review-findings/);
  assert.match(yaml, /path: \.iseol\/review\/iseol-review\.json/);
  assert.match(yaml, /if: always\(\)/);
});
