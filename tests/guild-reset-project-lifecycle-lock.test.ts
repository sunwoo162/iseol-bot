import assert from "node:assert/strict";
import test from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import type { Guild } from "discord.js";
import { resetGuildState } from "../src/services/guild-reset.js";
import { deleteProject, withProjectDeleteLock, type StoredProject } from "../src/services/projects.js";

const DATA_FILES = [
  "data/projects.json",
  "data/contest-feed.json",
  "data/contest-audience-feeds.json",
  "data/contest-votes.json",
  "data/job-feed.json",
  "data/music-playlists.json",
  "data/voice-study-time.json",
  "data/daily-scrum.json",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("guild reset waits for a concurrent project deletion before fetching channels", async () => {
  const previous = new Map<string, Buffer>();
  for (const file of DATA_FILES) {
    try { previous.set(file, await readFile(file)); } catch { /* test creates the file */ }
  }

  const project: StoredProject = {
    id: "guild-reset-project-lifecycle-lock",
    name: "Guild reset project lifecycle lock",
    guildId: "guild-reset-project-lifecycle-lock-guild",
    categoryId: "guild-reset-project-lifecycle-lock-category",
    organization: "iseol",
    frontend: { owner: "iseol", repo: "frontend" },
    backend: { owner: "iseol", repo: "backend" },
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let channelsFetched = false;
  const guild = {
    id: project.guildId,
    name: "Guild reset project lifecycle lock",
    channels: {
      fetch: async () => {
        channelsFetched = true;
        return new Map();
      },
    },
  } as unknown as Guild;

  try {
    await writeFile("data/projects.json", JSON.stringify([project], null, 2), "utf8");
    const deletion = withProjectDeleteLock(project.guildId, project.id, async () => {
      await held;
      assert.equal(await deleteProject(project.id), true);
    });

    await delay(30);
    const reset = resetGuildState(guild);
    await delay(80);
    assert.equal(channelsFetched, false);

    release();
    await Promise.all([deletion, reset]);
    assert.equal(channelsFetched, true);
  } finally {
    for (const file of DATA_FILES) {
      const content = previous.get(file);
      if (content) await writeFile(file, content);
      else await rm(file, { force: true });
    }
  }
});
