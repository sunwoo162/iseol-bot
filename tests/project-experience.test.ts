import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjectHubId,
  parseProjectHubId,
} from "../src/services/project-experience/project-custom-id.js";
import { projectHealthLines } from "../src/services/project-experience/project-health.js";

test("project hub custom ids round-trip", () => {
  const id = buildProjectHubId("calendar", "abc123");
  assert.equal(id, "project_hub:calendar:abc123");
  assert.deepEqual(parseProjectHubId(id), { action: "calendar", projectId: "abc123" });
  assert.equal(parseProjectHubId("calendar:add:abc123"), null);
});

test("project health uses short user-facing states", () => {
  const lines = projectHealthLines({
    github: "connected",
    review: "needs_admin",
    calendar: "needs_setup",
    scrum: "connected",
    notion: "connected",
    figma: "needs_setup",
  });

  assert.ok(lines.some((line) => line.includes("Code Review") && line.includes("관리자 설정 필요")));
  assert.ok(lines.some((line) => line.includes("Google Calendar") && line.includes("설정 필요")));
  assert.ok(lines.every((line) => !line.includes("403")));
});
