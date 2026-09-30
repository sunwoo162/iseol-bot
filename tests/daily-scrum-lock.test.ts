import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DailyScrumStore, type DailyScrumRecord } from "../src/services/daily-scrum.js";

function record(projectId: string, userId: string): DailyScrumRecord {
  return {
    guildId: `guild-${projectId}`,
    projectId,
    userId,
    date: "2026-09-30",
    todo: `todo-${projectId}`,
    did: `did-${projectId}`,
    channelId: `channel-${projectId}`,
    messageId: `message-${projectId}`,
    updatedAt: "2026-09-30T06:00:00.000Z",
  };
}

test("daily scrum state preserves concurrent records from independent stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-daily-scrum-lock-"));
  const file = join(dir, "daily-scrum.json");
  const first = new DailyScrumStore(file);
  const second = new DailyScrumStore(file);

  await Promise.all([
    first.saveRecord(record("project-a", "user-a")),
    second.saveRecord(record("project-b", "user-b")),
  ]);

  assert.ok(await new DailyScrumStore(file).getRecord("project-a", "user-a", "2026-09-30"));
  assert.ok(await new DailyScrumStore(file).getRecord("project-b", "user-b", "2026-09-30"));
  await rm(dir, { recursive: true, force: true });
});

test("daily scrum state preserves concurrent project clears from independent stores", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-daily-scrum-clear-lock-"));
  const file = join(dir, "daily-scrum.json");
  const first = new DailyScrumStore(file);
  const second = new DailyScrumStore(file);
  await first.saveRecord(record("project-a", "user-a"));
  await first.saveRecord(record("project-b", "user-b"));

  await Promise.all([
    first.clearProject("project-a"),
    second.clearProject("project-b"),
  ]);

  const result = new DailyScrumStore(file);
  assert.equal(await result.getRecord("project-a", "user-a", "2026-09-30"), null);
  assert.equal(await result.getRecord("project-b", "user-b", "2026-09-30"), null);
  await rm(dir, { recursive: true, force: true });
});
