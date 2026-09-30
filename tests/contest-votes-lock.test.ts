import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContestVoteStore } from "../src/services/contest-votes.js";

function vote(id: string, guildId: string): Parameters<ContestVoteStore["save"]>[0] {
  return {
    id,
    guildId,
    channelId: `channel-${guildId}`,
    messageId: `message-${id}`,
    title: `Contest ${id}`,
    url: `https://example.com/${id}`,
    voterIds: [],
    finalized: false,
  };
}

test("contest vote state preserves concurrent saves from independent stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-contest-votes-lock-"));
  const file = join(dir, "contest-votes.json");
  const first = new ContestVoteStore(file);
  const second = new ContestVoteStore(file);

  await Promise.all([
    first.save(vote("vote-a", "guild-a")),
    second.save(vote("vote-b", "guild-b")),
  ]);

  const result = await new ContestVoteStore(file).list();
  assert.deepEqual(result.map((item) => item.id).sort(), ["vote-a", "vote-b"]);
  await rm(dir, { recursive: true, force: true });
});

test("contest vote state preserves concurrent updates from independent stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-contest-votes-update-lock-"));
  const file = join(dir, "contest-votes.json");
  const first = new ContestVoteStore(file);
  const second = new ContestVoteStore(file);
  await first.save(vote("vote-a", "guild-a"));
  await first.save(vote("vote-b", "guild-b"));

  await Promise.all([
    first.update("vote-a", { status: "approved" }),
    second.update("vote-b", { status: "rejected" }),
  ]);

  const result = await new ContestVoteStore(file).list();
  assert.deepEqual(result.map((item) => [item.id, item.status]).sort(), [
    ["vote-a", "approved"],
    ["vote-b", "rejected"],
  ]);
  await rm(dir, { recursive: true, force: true });
});
