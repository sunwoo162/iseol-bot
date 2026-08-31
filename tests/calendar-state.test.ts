import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CalendarStateStore, calendarExternalKey } from "../src/services/calendar/calendar-state.js";

test("calendar external keys are stable", () => {
  assert.equal(calendarExternalKey("abc", "owner/repo", "issue", 42), "abc:owner/repo:issue:42");
});

test("calendar mappings can be created, updated, and deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-calendar-"));
  const file = join(dir, "state.json");
  const store = new CalendarStateStore(file);
  const key = calendarExternalKey("project", "owner/repo", "issue", 7);

  await store.upsert({ externalKey: key, projectId: "project", calendarId: "cal", eventId: "event-1", source: "issue" });
  assert.equal((await store.find(key))?.eventId, "event-1");

  await store.upsert({ externalKey: key, projectId: "project", calendarId: "cal", eventId: "event-2", source: "issue" });
  assert.equal((await store.find(key))?.eventId, "event-2");

  assert.equal(await store.remove(key), true);
  assert.equal(await store.find(key), null);
  await rm(dir, { recursive: true, force: true });
});
