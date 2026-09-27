import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createLearningService } from "../src/learning/service.js";

const at = "2026-09-26T12:00:00.000Z";
function principal(userId: string): Principal { return { userId, sessionId: `${userId}-session`, roles: ["user"] }; }

test("a local-template plan can be activated into an owner-bound day session without claiming content generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-learning-goal-start-"));
  const service = createLearningService(root, { now: () => at });
  const owner = principal("user-a");
  const other = principal("user-b");
  const goal = await service.createLearningGoal(owner, { subjectText: "TypeScript", duration: { days: 3 }, dailyMinutes: 20 });
  const preview = await service.createLearningPlanPreview(owner, goal.id, goal.revision);

  const session = await service.startLearningGoalSession(owner, goal.id, { planVersionId: preview.plan.id, dayId: preview.plan.days[0]!.id, expectedRevision: preview.goal.revision });
  assert.equal(session.status, "active");
  assert.equal(session.goalId, goal.id);
  assert.equal(session.planVersionId, preview.plan.id);
  assert.equal(session.dayId, preview.plan.days[0]!.id);
  assert.equal(session.contentStatus, "not-requested");
  assert.equal((await service.getLearningGoal(owner, goal.id))?.status, "active");
  assert.equal((await service.getLearningGoal(owner, goal.id))?.revision, preview.goal.revision + 1);
  assert.equal((await service.getLearningPlanVersion(owner, goal.id, preview.plan.id))?.status, "active");
  assert.equal(await service.startLearningGoalSession(other, goal.id, { planVersionId: preview.plan.id, dayId: preview.plan.days[0]!.id }).then(() => false, () => true), true);

  const repeated = await service.startLearningGoalSession(owner, goal.id, { planVersionId: preview.plan.id, dayId: preview.plan.days[0]!.id, expectedRevision: preview.goal.revision + 1 });
  assert.equal(repeated.id, session.id);
  const restarted = createLearningService(root, { now: () => at });
  assert.deepEqual(await restarted.resumeLearningSession(owner, session.id), session);
});

test("goal session start rejects stale revisions, foreign plan versions, and unknown days", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-learning-goal-start-conflict-"));
  const service = createLearningService(root, { now: () => at });
  const owner = principal("owner");
  const other = principal("other");
  const goal = await service.createLearningGoal(owner, { subjectText: "복습", duration: { days: 2 }, dailyMinutes: 15 });
  const preview = await service.createLearningPlanPreview(owner, goal.id, goal.revision);
  await assert.rejects(() => service.startLearningGoalSession(owner, goal.id, { planVersionId: preview.plan.id, dayId: preview.plan.days[0]!.id, expectedRevision: goal.revision }), /conflict/i);
  await assert.rejects(() => service.startLearningGoalSession(other, goal.id, { planVersionId: preview.plan.id, dayId: preview.plan.days[0]!.id }), /not found|forbidden/i);
  await assert.rejects(() => service.startLearningGoalSession(owner, goal.id, { planVersionId: preview.plan.id, dayId: "missing-day", expectedRevision: preview.goal.revision }), /day|not found/i);
});
