import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import {
  findProjectTask,
  listMemberProjectTasks,
  listProjectTasks,
  saveProjectTask,
  updateProjectTask,
} from "../src/services/project-task.js";

const DATA_FILE = "data/project-tasks.json";

async function reset(): Promise<void> {
  await rm(DATA_FILE, { force: true }).catch(() => undefined);
}

test("project task state saves, updates and scopes member listings", async () => {
  await reset();
  try {
    const first = await saveProjectTask({
      projectId: "project-a",
      guildId: "guild-a",
      creatorDiscordId: "user-a",
      githubUsername: "sunwoo162",
      repositorySide: "frontend",
      repository: "rain-gj/rain-gj-frontend",
      issueNumber: 42,
      issueUrl: "https://github.com/rain-gj/rain-gj-frontend/issues/42",
      calendarEventId: "event-42",
      title: "로그인 API 연동",
      body: "로그인 API를 연결한다.",
      start: "2026-09-05T18:00:00+09:00",
      end: "2026-09-05T19:00:00+09:00",
      status: "open",
    });

    await saveProjectTask({
      projectId: "project-a",
      guildId: "guild-a",
      creatorDiscordId: "user-b",
      repositorySide: "frontend",
      repository: "rain-gj/rain-gj-frontend",
      issueNumber: 43,
      issueUrl: "https://github.com/rain-gj/rain-gj-frontend/issues/43",
      title: "다른 사람 작업",
      body: "",
      start: "2026-09-06T10:00:00+09:00",
      end: "2026-09-06T11:00:00+09:00",
      status: "open",
    });

    const found = await findProjectTask(first.id);
    assert.equal(found?.issueNumber, 42);
    assert.equal(found?.status, "open");

    const updated = await updateProjectTask(first.id, {
      status: "completed",
      discordChannelId: "calendar-channel",
      discordMessageId: "task-card",
    });
    assert.equal(updated?.status, "completed");
    assert.equal(updated?.discordMessageId, "task-card");

    const projectTasks = await listProjectTasks("guild-a", "project-a");
    assert.equal(projectTasks.length, 2);

    const memberTasks = await listMemberProjectTasks("guild-a", "project-a", "user-a");
    assert.deepEqual(memberTasks.map((task) => task.id), [first.id]);
  } finally {
    await reset();
  }
});
