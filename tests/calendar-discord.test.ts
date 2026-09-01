import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarPanelDescription,
  parseCalendarCustomId,
  parseKstDateTime,
  parseRepositorySide,
  resolveCalendarRange,
} from "../src/services/calendar/calendar-discord.js";

const NOW = new Date("2026-09-01T06:00:00.000Z"); // 2026-09-01 15:00 KST

test("calendar custom ids identify project and action", () => {
  assert.deepEqual(parseCalendarCustomId("calendar:add:abc123"), { action: "add", projectId: "abc123" });
  assert.equal(parseCalendarCustomId("other:add:abc123"), null);
});

test("calendar date parser accepts full, month/day, today and tomorrow forms", () => {
  assert.equal(parseKstDateTime("2026-09-03 14:30", NOW), "2026-09-03T14:30:00+09:00");
  assert.equal(parseKstDateTime("9/3 14:30", NOW), "2026-09-03T14:30:00+09:00");
  assert.equal(parseKstDateTime("오늘 18:00", NOW), "2026-09-01T18:00:00+09:00");
  assert.equal(parseKstDateTime("내일 09:15", NOW), "2026-09-02T09:15:00+09:00");
});

test("calendar date parser rejects normalized invalid dates", () => {
  assert.throws(() => parseKstDateTime("2026-02-31 14:00", NOW), /올바른 날짜/);
  assert.throws(() => parseKstDateTime("13/40 14:00", NOW), /올바른 날짜/);
  assert.throws(() => parseKstDateTime("2026-09-01", NOW), /날짜/);
});

test("calendar range defaults end to one hour and accepts bare end time", () => {
  assert.deepEqual(resolveCalendarRange("내일 14:00", "", NOW), {
    start: "2026-09-02T14:00:00+09:00",
    end: "2026-09-02T15:00:00+09:00",
  });
  assert.deepEqual(resolveCalendarRange("9/3 14:00", "16:30", NOW), {
    start: "2026-09-03T14:00:00+09:00",
    end: "2026-09-03T16:30:00+09:00",
  });
  assert.throws(() => resolveCalendarRange("내일 14:00", "13:00", NOW), /종료 시간/);
});

test("calendar panel copy stays compact", () => {
  const text = calendarPanelDescription("https://calendar.google.com/test");
  assert.match(text, /일정 추가/);
  assert.match(text, /Google Calendar/);
  assert.ok(text.length < 500);
});

test("github issue repository selector accepts frontend or backend only", () => {
  assert.equal(parseRepositorySide(" FRONTEND "), "frontend");
  assert.equal(parseRepositorySide("backend"), "backend");
  assert.throws(() => parseRepositorySide("api"), /frontend 또는 backend/);
});
