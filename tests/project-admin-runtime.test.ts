import assert from "node:assert/strict";
import test from "node:test";
import { formatProjectRepairResult } from "../src/services/project-experience/project-admin-runtime.js";
import {
  calendarQuickConnectPlan,
  formatQuickConnectResult,
} from "../src/services/project-experience/project-connect-runtime.js";
import type { StoredProject } from "../src/services/projects.js";

const project: StoredProject = {
  id: "p1",
  name: "Rain GJ",
  guildId: "guild1",
  categoryId: "category1",
  organization: "rain-gj",
  frontend: { owner: "rain-gj", repo: "frontend", url: "https://github.com/rain-gj/frontend" },
  backend: { owner: "rain-gj", repo: "backend", url: "https://github.com/rain-gj/backend" },
};

test("repair result copy is compact and never exposes raw internal errors", () => {
  const text = formatProjectRepairResult({
    repaired: ["Discord 프로젝트 패널", "Code Review · rain-gj/frontend"],
    unchanged: ["Code Review · rain-gj/backend"],
    needsAdmin: ["Code Review · rain-gj/private"],
    failed: ["Discord 프로젝트 패널"],
  });

  assert.match(text, /복구됨/);
  assert.match(text, /변경 없음/);
  assert.match(text, /관리자 설정 필요/);
  assert.match(text, /실패/);
  assert.ok(!/403|token|PAT|Resource not accessible/i.test(text));
});

test("calendar quick connect never creates duplicates and distinguishes missing server oauth", () => {
  assert.equal(calendarQuickConnectPlan({ ...project, calendarId: "calendar1" }, true), "already_connected");
  assert.equal(calendarQuickConnectPlan(project, false), "needs_admin");
  assert.equal(calendarQuickConnectPlan(project, true), "create");
});

test("quick connect result stays compact and hides raw api details", () => {
  const text = formatQuickConnectResult({
    connected: ["Google Calendar", "GitHub 프로젝트"],
    unchanged: ["Discord 프로젝트 공간"],
    needsAdmin: ["Code Review"],
    failed: ["Figma"],
  });

  assert.match(text, /연결됨/);
  assert.match(text, /변경 없음/);
  assert.match(text, /관리자 설정 필요/);
  assert.ok(!/403|token|PAT|Resource not accessible/i.test(text));
});
