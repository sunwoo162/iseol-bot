import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContestAudienceFeedStore, type ContestAudienceFeedState } from "../src/services/contest-audience-feed.js";

function state(guildId: string, audienceFilter: ContestAudienceFeedState["audienceFilter"]): ContestAudienceFeedState {
  return {
    guildId,
    categoryId: `category-${guildId}`,
    channelId: `channel-${audienceFilter}`,
    audienceFilter,
    postedKeys: [],
    createdAt: new Date(0).toISOString(),
  };
}

test("contest audience feed state preserves concurrent saves from independent stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-contest-audience-feed-lock-"));
  const file = join(dir, "contest-audience-feeds.json");
  const first = new ContestAudienceFeedStore(file);
  const second = new ContestAudienceFeedStore(file);

  await Promise.all([
    first.save(state("guild-a", "high-school")),
    second.save(state("guild-a", "university")),
  ]);

  const result = await new ContestAudienceFeedStore(file).list();
  assert.deepEqual(result.map((item) => item.audienceFilter).sort(), ["high-school", "university"]);
  await rm(dir, { recursive: true, force: true });
});

test("contest audience feed state updates are serialized across independent stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-contest-audience-feed-update-lock-"));
  const file = join(dir, "contest-audience-feeds.json");
  const first = new ContestAudienceFeedStore(file);
  const second = new ContestAudienceFeedStore(file);
  await first.save(state("guild-a", "high-school"));
  await first.save(state("guild-b", "university"));

  await Promise.all([
    first.update("guild-a", "high-school", (current) => ({ ...current, postedKeys: ["alpha"] })),
    second.update("guild-b", "university", (current) => ({ ...current, postedKeys: ["beta"] })),
  ]);

  const result = await new ContestAudienceFeedStore(file).list();
  assert.deepEqual(result.map((item) => [item.guildId, item.postedKeys]).sort(), [
    ["guild-a", ["alpha"]],
    ["guild-b", ["beta"]],
  ]);
  await rm(dir, { recursive: true, force: true });
});
