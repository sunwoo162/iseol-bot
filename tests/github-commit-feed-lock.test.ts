import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GitHubCommitFeedStore, type CommitFeedState } from "../src/services/github-commit-feed.js";

function state(key: string, guildId = key): CommitFeedState {
  return {
    key,
    guildId,
    projectId: `project-${key}`,
    side: "frontend",
    seenEventIds: [],
    seenCommitShas: [],
    initializedAt: new Date(0).toISOString(),
  };
}

test("GitHub commit feed state preserves concurrent saves from independent stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-github-commit-feed-lock-"));
  const file = join(dir, "github-commit-feed.json");
  const first = new GitHubCommitFeedStore(file);
  const second = new GitHubCommitFeedStore(file);

  await Promise.all([
    first.save(state("project-a:frontend")),
    second.save(state("project-b:backend")),
  ]);

  const result = await new GitHubCommitFeedStore(file).list();
  assert.deepEqual(result.map((item) => item.key).sort(), ["project-a:frontend", "project-b:backend"]);
  await rm(dir, { recursive: true, force: true });
});

test("GitHub commit feed state updates are serialized across independent stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-github-commit-feed-update-lock-"));
  const file = join(dir, "github-commit-feed.json");
  const first = new GitHubCommitFeedStore(file);
  const second = new GitHubCommitFeedStore(file);
  await first.save(state("project-a:frontend"));
  await first.save(state("project-b:backend"));

  await Promise.all([
    first.update("project-a:frontend", (current) => ({ ...current, seenCommitShas: ["sha-a"] })),
    second.update("project-b:backend", (current) => ({ ...current, seenCommitShas: ["sha-b"] })),
  ]);

  const result = await new GitHubCommitFeedStore(file).list();
  assert.deepEqual(result.map((item) => [item.key, item.seenCommitShas]).sort(), [
    ["project-a:frontend", ["sha-a"]],
    ["project-b:backend", ["sha-b"]],
  ]);
  await rm(dir, { recursive: true, force: true });
});
