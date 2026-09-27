import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createLearningService } from "../src/learning/service.js";

const at = "2026-09-26T12:00:00.000Z";
function principal(userId: string): Principal { return { userId, sessionId: `${userId}-session`, roles: ["user"] }; }

test("learning goals persist the three required inputs and remain owner-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-learning-goals-"));
  const service = createLearningService(root, { now: () => at });
  const goal = await service.createLearningGoal(principal("user-a"), {
    subjectText: "TypeScript generics",
    duration: { days: 30 },
    dailyMinutes: 60,
  });

  assert.equal(goal.status, "draft");
  assert.equal(goal.revision, 1);
  assert.deepEqual(goal.input, { subjectText: "TypeScript generics", duration: { days: 30 }, dailyMinutes: 60 });
  const restarted = createLearningService(root, { now: () => at });
  assert.deepEqual(await restarted.getLearningGoal(principal("user-a"), goal.id), goal);
  assert.deepEqual(await restarted.listLearningGoals(principal("user-b")), []);
  assert.equal(await restarted.getLearningGoal(principal("user-b"), goal.id), null);
});

test("learning goals reject out-of-range duration and daily study time", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-learning-goal-validation-"));
  const service = createLearningService(root, { now: () => at });
  await assert.rejects(() => service.createLearningGoal(principal("user-a"), { subjectText: "", duration: { days: 30 }, dailyMinutes: 60 }), /subject/i);
  await assert.rejects(() => service.createLearningGoal(principal("user-a"), { subjectText: "TypeScript", duration: { days: 0 }, dailyMinutes: 60 }), /duration/i);
  await assert.rejects(() => service.createLearningGoal(principal("user-a"), { subjectText: "TypeScript", duration: { days: 30 }, dailyMinutes: 0 }), /daily|minute/i);
});

test("learning goals reject impossible or past target dates", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-learning-goal-target-date-"));
  const service = createLearningService(root, { now: () => at });
  await assert.rejects(() => service.createLearningGoal(principal("user-a"), { subjectText: "TypeScript", duration: { targetDate: "2027-02-30" }, dailyMinutes: 60 }), /duration/i);
  await assert.rejects(() => service.createLearningGoal(principal("user-a"), { subjectText: "TypeScript", duration: { targetDate: "2026-09-25" }, dailyMinutes: 60 }), /duration/i);
  const goal = await service.createLearningGoal(principal("user-a"), { subjectText: "TypeScript", duration: { targetDate: "2026-09-27" }, dailyMinutes: 60 });
  assert.deepEqual(goal.input.duration, { targetDate: "2026-09-27" });
});
