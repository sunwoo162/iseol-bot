import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectTaskId,
  memberTaskSummary,
  parseProjectTaskId,
  taskCardPayload,
  taskCreateModal,
  taskEditModal,
} from "../src/services/project-task-discord.js";
import type { StoredProjectTask } from "../src/services/project-task.js";

const task: StoredProjectTask = {
  id: "task42",
  projectId: "project1",
  guildId: "guild1",
  creatorDiscordId: "user1",
  githubUsername: "sunwoo162",
  repositorySide: "frontend",
  repository: "rain-gj/rain-gj-frontend",
  issueNumber: 42,
  issueUrl: "https://github.com/rain-gj/rain-gj-frontend/issues/42",
  calendarEventId: "event42",
  discordChannelId: "calendar-channel",
  discordMessageId: "message42",
  title: "로그인 API 연동",
  body: "로그인 API를 구현한다.",
  start: "2026-09-05T18:00:00+09:00",
  end: "2026-09-05T19:00:00+09:00",
  status: "open",
  createdAt: "2026-09-01T14:00:00.000Z",
  updatedAt: "2026-09-01T14:00:00.000Z",
};

test("project task custom ids round-trip", () => {
  for (const action of ["create", "my", "complete", "edit", "more"] as const) {
    const id = buildProjectTaskId(action, action === "create" || action === "my" ? "project1" : "task42");
    assert.deepEqual(parseProjectTaskId(id), {
      action,
      id: action === "create" || action === "my" ? "project1" : "task42",
    });
  }
});

test("task create modal only asks for title due and optional description", () => {
  const json = taskCreateModal("project1").toJSON();
  assert.equal(json.custom_id, "project_task_create_modal:project1");
  const inputs = json.components.flatMap((row: any) => row.components).map((input: any) => ({
    id: input.custom_id,
    required: input.required,
  }));
  assert.deepEqual(inputs, [
    { id: "title", required: true },
    { id: "start", required: true },
    { id: "body", required: false },
  ]);
});

test("task card exposes complete edit and more without raw ids", () => {
  const payload = taskCardPayload(task);
  const json = payload.components[0]!.toJSON();
  assert.deepEqual(json.components.map((button: any) => button.label), ["완료", "수정", "더보기"]);
  const description = payload.embeds[0]!.toJSON().description ?? "";
  assert.match(description, /@?user1|<@user1>/);
  assert.match(description, /Frontend #42/);
  assert.doesNotMatch(description, /event42/);
});

test("completed task card disables completion and marks status", () => {
  const payload = taskCardPayload({ ...task, status: "completed" });
  const json = payload.components[0]!.toJSON();
  assert.equal((json.components[0] as any).disabled, true);
  assert.match(payload.embeds[0]!.toJSON().description ?? "", /완료/);
});

test("task edit modal is prefilled from stored task", () => {
  const json = taskEditModal(task).toJSON();
  assert.equal(json.custom_id, "project_task_edit_modal:task42");
  const inputs = json.components.flatMap((row: any) => row.components);
  assert.equal(inputs[0]?.value, "로그인 API 연동");
  assert.match(inputs[1]?.value ?? "", /2026-09-05 18:00/);
  assert.equal(inputs[2]?.value, "로그인 API를 구현한다.");
});

test("member task summary shows only open task links passed to it", () => {
  const summary = memberTaskSummary([task, { ...task, id: "done", status: "completed", issueNumber: 99 }]);
  assert.match(summary, /로그인 API 연동/);
  assert.match(summary, /#42/);
  assert.doesNotMatch(summary, /#99/);
});
