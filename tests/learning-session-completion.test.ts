import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createActivityService } from "../src/activity/service.js";
import { createGrowthService } from "../src/growth/read-model.js";
import { createLearningService } from "../src/learning/service.js";

const at = "2026-09-26T12:00:00.000Z";
function principal(userId: string): Principal { return { userId, sessionId: `${userId}-session`, roles: ["user"] }; }

test("learning session completion is owner-bound, durable, and idempotently attributed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-learning-completion-"));
  const activity = createActivityService(join(root, "activity"), { now: () => at });
  const growth = createGrowthService(join(root, "growth"), { now: () => at });
  const service = createLearningService(join(root, "learning"), { now: () => at, activityService: activity, growthService: growth });
  const owner = principal("learning-owner");
  const plan = await service.createLearningPlan(owner, { title: "Completion", description: "Finish a session", goals: ["Explain the result"] });
  const session = await service.startLearningSession(owner, plan.id);

  const completed = await service.completeLearningSession(owner, session.id);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.completedAt, at);
  assert.deepEqual(await service.completeLearningSession(owner, session.id), completed);

  const restarted = createLearningService(join(root, "learning"), { now: () => at, activityService: activity, growthService: growth });
  assert.deepEqual(await restarted.resumeLearningSession(owner, session.id), completed);
  const events = await activity.listActivityEvents(owner);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventType, "learning.session.completed");
  assert.equal(events[0]?.sourceId, session.id);
  assert.equal(events[0]?.actorType, "user");
  assert.equal(events[0]?.verificationStatus, "verified");
  assert.equal((await growth.getGrowthSnapshot(owner)).stats.learning, 100);
  await assert.rejects(
    () => restarted.recordStudyAttempt(owner, { sessionId: session.id, questionId: "after-complete", answer: "must be rejected" }),
    /completed/i,
  );
  assert.equal(await restarted.completeLearningSession(principal("other-user"), session.id), null);
});
