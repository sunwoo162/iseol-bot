import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createLearningService } from "../src/learning/service.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { startWebControlPlaneServer } from "../src/web-control-plane/server.js";

test("learning goal API stores the required input and does not expose another user's goal", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-learning-goal-api-"));
  const now = () => "2026-09-26T12:00:00.000Z";
  const platform = createPlatformUserService(join(root, "platform"), { now });
  const learning = createLearningService(join(root, "platform"), { now });
  const userA = await platform.createUser({ id: "goal-api-a", email: "goal-a@example.com", displayName: "A", timezone: "Asia/Seoul" });
  const userB = await platform.createUser({ id: "goal-api-b", email: "goal-b@example.com", displayName: "B", timezone: "Asia/Seoul" });
  const sessionA = await platform.createSession({ userId: userA.id, roles: ["user"], expiresAt: "2026-09-27T12:00:00.000Z" });
  const sessionB = await platform.createSession({ userId: userB.id, roles: ["user"], expiresAt: "2026-09-27T12:00:00.000Z" });
  const server = await startWebControlPlaneServer({
    host: "127.0.0.1", port: 0, token: "operator", modelRoot: join(root, "model"), harnessRoot: join(root, "runs"), webRoot: join(root, "web"),
    userService: platform, learningService: learning,
  });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const headersA = { authorization: `Bearer ${sessionA.token}`, "content-type": "application/json" };
  const headersB = { authorization: `Bearer ${sessionB.token}` };
  try {
    const created = await fetch(`${url}/api/user/learning/goals`, { method: "POST", headers: headersA, body: JSON.stringify({ subjectText: "자료구조", duration: { days: 14 }, dailyMinutes: 30 }) });
    assert.equal(created.status, 201);
    const goal = (await created.json() as any).goal;
    assert.equal(goal.status, "draft");
    const listA = await fetch(`${url}/api/user/learning/goals`, { headers: headersA });
    assert.deepEqual((await listA.json() as any).goals.map((item: any) => item.id), [goal.id]);
    const listB = await fetch(`${url}/api/user/learning/goals`, { headers: headersB });
    assert.deepEqual((await listB.json() as any).goals, []);
    const detailB = await fetch(`${url}/api/user/learning/goals/${encodeURIComponent(goal.id)}`, { headers: headersB });
    assert.equal(detailB.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
