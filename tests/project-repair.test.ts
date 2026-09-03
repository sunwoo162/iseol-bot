import assert from "node:assert/strict";
import test from "node:test";
import { repairProject } from "../src/services/project-experience/project-repair.js";
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

test("project repair combines discord ensure and review workflow repair safely", async () => {
  let experienceCalls = 0;
  let reviewCalls = 0;

  const result = await repairProject(project, {
    ensureExperience: async () => {
      experienceCalls += 1;
      return { hubPanelMessageId: "hub1", scrumChannelId: "scrum1", scrumPanelMessageId: "scrum-panel1" };
    },
    ensureReviewWorkflows: async () => {
      reviewCalls += 1;
      return [
        { repository: "rain-gj/frontend", created: true },
        { repository: "rain-gj/backend", created: false, error: "HTTP 403 Resource not accessible by personal access token" },
      ];
    },
  });

  assert.equal(experienceCalls, 1);
  assert.equal(reviewCalls, 1);
  assert.ok(result.repaired.some((item) => item.includes("Discord")));
  assert.ok(result.repaired.some((item) => item.includes("rain-gj/frontend")));
  assert.ok(result.needsAdmin.some((item) => item.includes("rain-gj/backend")));
  assert.ok(result.failed.every((item) => !/403|token|PAT/i.test(item)));
  assert.ok(result.needsAdmin.every((item) => !/403|token|PAT/i.test(item)));
});

test("project repair stays idempotent when resources already exist", async () => {
  const current: StoredProject = {
    ...project,
    hubPanelMessageId: "hub1",
    scrumChannelId: "scrum1",
    scrumPanelMessageId: "scrum-panel1",
  };

  const result = await repairProject(current, {
    ensureExperience: async () => ({
      hubPanelMessageId: "hub1",
      scrumChannelId: "scrum1",
      scrumPanelMessageId: "scrum-panel1",
    }),
    ensureReviewWorkflows: async () => [
      { repository: "rain-gj/frontend", created: false },
      { repository: "rain-gj/backend", created: false },
    ],
  });

  assert.equal(result.repaired.length, 0);
  assert.ok(result.unchanged.includes("Discord 프로젝트 패널"));
  assert.ok(result.unchanged.some((item) => item.includes("rain-gj/frontend")));
  assert.ok(result.unchanged.some((item) => item.includes("rain-gj/backend")));
});
