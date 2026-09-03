import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectScrumId,
  parseProjectScrumId,
  recentScrumText,
  scrumPanelMessage,
  scrumPinnedGuideMessage,
  scrumWriteDefaults,
} from "../src/services/daily-scrum-discord.js";
import {
  selectDailyScrumReminderTargets,
  selectRecentDailyScrumRecords,
  type DailyScrumRecord,
  type DailyScrumReminderTarget,
} from "../src/services/daily-scrum.js";
import type { StoredProject } from "../src/services/projects.js";

const projectFixture: StoredProject = {
  id: "p1",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "category1",
  organization: "rain-gj",
  frontend: {
    owner: "rain-gj",
    repo: "frontend",
    url: "https://github.com/rain-gj/frontend",
  },
  backend: {
    owner: "rain-gj",
    repo: "backend",
    url: "https://github.com/rain-gj/backend",
  },
  scrumChannelId: "scrum1",
};

const todayRecord: DailyScrumRecord = {
  guildId: "guild1",
  projectId: "p1",
  userId: "user1",
  date: "2026-09-01",
  todo: "로그인 API, 테스트",
  did: "회원가입 UI",
  channelId: "scrum1",
  messageId: "message1",
  updatedAt: "2026-09-01T01:00:00.000Z",
};

const yesterdayRecord: DailyScrumRecord = {
  ...todayRecord,
  date: "2026-08-31",
  todo: "회원가입 UI, 약관 검증",
  did: "",
  messageId: "message0",
  updatedAt: "2026-08-31T01:00:00.000Z",
};

test("project scrum custom ids round-trip", () => {
  const id = buildProjectScrumId("write", "p1");
  assert.equal(id, "project_scrum:write:p1");
  assert.deepEqual(parseProjectScrumId(id), { action: "write", projectId: "p1" });
  assert.deepEqual(parseProjectScrumId("project_scrum:carry:p1"), { action: "carry", projectId: "p1" });
  assert.deepEqual(parseProjectScrumId("project_scrum:recent:p1"), { action: "recent", projectId: "p1" });
  assert.equal(parseProjectScrumId("project_scrum:delete:p1"), null);
});

test("scrum panel exposes the three member actions", () => {
  const payload = scrumPanelMessage(projectFixture);
  const ids = payload.components.flatMap((row) =>
    row.components.map((item) => item.data.custom_id),
  );

  assert.deepEqual(ids, [
    "project_scrum:write:p1",
    "project_scrum:carry:p1",
    "project_scrum:recent:p1",
  ]);
  assert.match(payload.embeds[0]?.data.title ?? "", /데일리 스크럼/);
});

test("pinned scrum guide has no interaction buttons and points to the project hub", () => {
  const hubUrl = "https://discord.com/channels/guild1/hub-channel/hub-message";
  const payload = scrumPinnedGuideMessage(projectFixture, hubUrl);

  assert.equal(payload.components.length, 0);
  const description = payload.embeds[0]?.data.description ?? "";
  assert.match(description, /프로젝트.*스크럼/);
  assert.match(description, /https:\/\/discord\.com\/channels\/guild1\/hub-channel\/hub-message/);
});

test("duplicate stored projects produce one daily scrum reminder per Discord channel", () => {
  const targets: DailyScrumReminderTarget[] = [
    { projectId: "p1", guildId: "guild1", channelId: "scrum1" },
    { projectId: "p2", guildId: "guild1", channelId: "scrum1" },
    { projectId: "p3", guildId: "guild1", channelId: "scrum1" },
  ];

  assert.deepEqual(
    selectDailyScrumReminderTargets(targets, {}, "2026-09-02"),
    [targets[0]],
  );
});

test("legacy project reminder state suppresses the whole shared scrum channel for the day", () => {
  const targets: DailyScrumReminderTarget[] = [
    { projectId: "p1", guildId: "guild1", channelId: "scrum1" },
    { projectId: "p2", guildId: "guild1", channelId: "scrum1" },
  ];

  assert.deepEqual(
    selectDailyScrumReminderTargets(targets, { p1: "2026-09-02" }, "2026-09-02"),
    [],
  );
});

test("scrum write pre-fills today's existing values", () => {
  assert.deepEqual(scrumWriteDefaults(todayRecord, yesterdayRecord, false), {
    todo: "로그인 API, 테스트",
    did: "회원가입 UI",
  });
});

test("carry flow prepares yesterday TODO as DID and keeps today's TODO", () => {
  assert.deepEqual(scrumWriteDefaults(todayRecord, yesterdayRecord, true), {
    todo: "로그인 API, 테스트",
    did: "회원가입 UI, 약관 검증",
  });
});

test("recent scrum selection never returns another user's records", () => {
  const otherUser: DailyScrumRecord = {
    ...todayRecord,
    userId: "user2",
    todo: "다른 사람 기록",
    messageId: "other-message",
  };
  const older: DailyScrumRecord = {
    ...todayRecord,
    date: "2026-08-30",
    todo: "오래된 내 기록",
    messageId: "older-message",
    updatedAt: "2026-08-30T01:00:00.000Z",
  };

  const selected = selectRecentDailyScrumRecords(
    [older, otherUser, yesterdayRecord, todayRecord],
    "p1",
    "user1",
    2,
  );

  assert.deepEqual(selected.map((record) => record.date), ["2026-09-01", "2026-08-31"]);
  assert.ok(selected.every((record) => record.userId === "user1"));
  assert.doesNotMatch(recentScrumText(selected), /다른 사람 기록/);
});
