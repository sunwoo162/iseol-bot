import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Principal } from "../src/identity/contracts.js";
import { createActivityService } from "../src/activity/service.js";
import { createGrowthService } from "../src/growth/read-model.js";

const at = "2026-09-25T12:00:00.000Z";

function principal(userId: string): Principal {
  return { userId, sessionId: `${userId}-session`, roles: ["user"] };
}

test("verified activity produces one actor-attributed growth entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-growth-ledger-"));
  const activity = createActivityService(root, { now: () => at });
  const growth = createGrowthService(root, { now: () => at });
  const event = await activity.recordActivityEvent(principal("user-a"), {
    sourceType: "learning-session",
    sourceId: "session-1",
    eventType: "learning.session.completed",
    eventVersion: 1,
    actorType: "user",
    verificationStatus: "verified",
    payload: { topic: "TypeScript" },
  });
  const entry = await growth.applyGrowthProjection(event);
  const duplicate = await growth.applyGrowthProjection(event);
  assert.ok(entry);
  assert.deepEqual(duplicate, entry);
  assert.deepEqual(await growth.getGrowthSnapshot(principal("user-a")), {
    userId: "user-a",
    level: 1,
    xp: 100,
    xpMax: 1000,
    stats: { development: 0, learning: 100, collaboration: 0, consistency: 0 },
    actorBreakdown: { user: 100, ai: 0, system: 0 },
    evidenceEventIds: [event.id],
    achievements: [{
      id: "first-evidence",
      badgeKey: "verified-evidence-1",
      title: "첫 검증 기록",
      description: "검증된 성장 증거를 처음 남겼습니다.",
      unlockedAt: at,
      evidenceEventIds: [event.id],
    }, {
      id: "learning-session",
      badgeKey: "learning-session-1",
      title: "학습 기록",
      description: "검증된 학습 세션을 완료했습니다.",
      unlockedAt: at,
      evidenceEventIds: [event.id],
    }],
  });
});

test("unverified activity never creates growth and users cannot see another user's ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-growth-isolation-"));
  const activity = createActivityService(root, { now: () => at });
  const growth = createGrowthService(root, { now: () => at });
  const event = await activity.recordActivityEvent(principal("user-a"), {
    sourceType: "fixture",
    sourceId: "fixture-1",
    eventType: "project.run.completed",
    eventVersion: 1,
    actorType: "system",
    verificationStatus: "unverified",
  });
  assert.equal(await growth.applyGrowthProjection(event), null);
  assert.equal((await growth.getGrowthSnapshot(principal("user-a"))).xp, 0);
  assert.equal((await activity.listActivityEvents(principal("user-b"))).length, 0);
  assert.equal((await growth.getGrowthSnapshot(principal("user-b"))).xp, 0);
});

test("retracting verified evidence creates one compensating ledger entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-growth-retraction-"));
  const activity = createActivityService(root, { now: () => at });
  const growth = createGrowthService(root, { now: () => at });
  const original = await activity.recordActivityEvent(principal("user-a"), {
    sourceType: "project-run",
    sourceId: "run-1",
    eventType: "project.run.completed",
    eventVersion: 1,
    actorType: "ai",
    verificationStatus: "verified",
  });
  await growth.applyGrowthProjection(original);
  const retracted = await activity.retractActivityEvent(principal("user-a"), original.id, at);
  const correction = await growth.applyGrowthProjection(retracted);
  assert.equal(correction?.xpDelta, -150);
  assert.equal((await growth.applyGrowthProjection(retracted))?.id, correction?.id);
  const snapshot = await growth.getGrowthSnapshot(principal("user-a"));
  assert.equal(snapshot.xp, 0);
  assert.deepEqual(snapshot.actorBreakdown, { user: 0, ai: 0, system: 0 });
  assert.deepEqual(snapshot.evidenceEventIds, [original.id]);
});
