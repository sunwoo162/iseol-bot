import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createActivityService } from "../src/activity/service.js";
import { createGrowthService } from "../src/growth/read-model.js";
import type { Principal } from "../src/identity/contracts.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { startWebControlPlaneServer } from "../src/web-control-plane/server.js";

test("user activity API rejects client-submitted verified evidence and reads trusted growth", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-growth-api-"));
  const now = () => "2026-09-25T12:00:00.000Z";
  const platform = createPlatformUserService(join(root, "platform"), { now });
  const activity = createActivityService(join(root, "platform"), { now });
  const growth = createGrowthService(join(root, "platform"), { now });
  const user = await platform.createUser({ id: "growth-api-user", email: "growth@example.com", displayName: "Growth", timezone: "Asia/Seoul" });
  const session = await platform.createSession({ userId: user.id, roles: ["user"], expiresAt: "2026-09-26T12:00:00.000Z" });
  const server = await startWebControlPlaneServer({
    host: "127.0.0.1", port: 0, token: "operator", modelRoot: join(root, "model"), harnessRoot: join(root, "runs"), webRoot: join(root, "web"),
    userService: platform, activityService: activity, growthService: growth,
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  try {
    const unverified = await fetch(`${url}/api/user/activity`, {
      method: "POST", headers,
      body: JSON.stringify({ sourceType: "fixture", sourceId: "f-1", eventType: "learning.session.completed", eventVersion: 1, actorType: "system", verificationStatus: "unverified" }),
    });
    assert.equal(unverified.status, 201);
    assert.equal((await unverified.json() as any).growth, null);

    const verified = await fetch(`${url}/api/user/activity`, {
      method: "POST", headers,
      body: JSON.stringify({ sourceType: "learning-session", sourceId: "s-1", eventType: "learning.session.completed", eventVersion: 1, actorType: "user", verificationStatus: "verified" }),
    });
    assert.equal(verified.status, 403);
    assert.match(String((await verified.json() as any).error), /service-owned/i);

    const trustedPrincipal: Principal = { userId: user.id, sessionId: session.id, roles: ["user"] };
    const trustedEvent = await activity.recordActivityEvent(trustedPrincipal, {
      sourceType: "learning-session",
      sourceId: "s-1",
      eventType: "learning.session.completed",
      eventVersion: 1,
      actorType: "user",
      verificationStatus: "verified",
    });
    await growth.applyGrowthProjection(trustedEvent);

    const snapshot = await fetch(`${url}/api/user/growth`, { headers });
    const snapshotBody = await snapshot.json() as any;
    assert.equal(snapshotBody.xp, 100);
    assert.equal(snapshotBody.achievements.some((item: any) => item.id === "learning-session"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
