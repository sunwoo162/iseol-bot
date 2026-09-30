import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubAutomationPollStateStore } from "../src/services/github-automation-poll-state.js";

test("GitHub automation poll state preserves concurrent milestone updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-github-poll-state-lock-"));
  const file = join(dir, "state.json");
  const first = new GitHubAutomationPollStateStore(file);
  const second = new GitHubAutomationPollStateStore(file);
  await Promise.all([
    first.setMilestones("project-a", "owner/repo-a", { "milestone-1": "2026-09-30T07:00:00.000Z" }),
    second.setMilestones("project-b", "owner/repo-b", { "milestone-2": "2026-09-30T07:01:00.000Z" }),
  ]);

  const result = new GitHubAutomationPollStateStore(file);
  assert.deepEqual(await result.getMilestones("project-a", "owner/repo-a"), { "milestone-1": "2026-09-30T07:00:00.000Z" });
  assert.deepEqual(await result.getMilestones("project-b", "owner/repo-b"), { "milestone-2": "2026-09-30T07:01:00.000Z" });
  await rm(dir, { recursive: true, force: true });
});
