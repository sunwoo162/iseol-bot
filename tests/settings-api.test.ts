import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createSettingsService } from "../src/settings/service.js";
import { startWebControlPlaneServer } from "../src/web-control-plane/server.js";

test("settings API persists authenticated permission changes and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-settings-api-"));
  const platformRoot = join(root, "platform");
  const users = createPlatformUserService(platformRoot, { now: () => "2026-09-26T12:00:00.000Z" });
  const user = await users.createUser({ id: "settings-api-user", email: "settings-api@example.com", displayName: "Settings API", timezone: "Asia/Seoul" });
  const session = await users.createSession({ userId: user.id, roles: ["user"], expiresAt: "2026-09-27T12:00:00.000Z" });
  const server = await startWebControlPlaneServer({ host: "127.0.0.1", port: 0, token: "control-token", modelRoot: join(root, "model"), harnessRoot: join(root, "runs"), webRoot: join(root, "control-plane"), userUiRoot: join(root, "user-ui"), userService: users, settingsService: createSettingsService(platformRoot, { now: () => "2026-09-26T12:00:00.000Z" }) });
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/user/settings`;
  try {
    const unauthorized = await fetch(url);
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const update = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ aiAccess: { projectFiles: false }, privacy: { projectList: false } }) });
    assert.equal(update.status, 200);
    const body = await update.json() as { settings: { aiAccess: { projectFiles: boolean }; privacy: { projectList: boolean } } };
    assert.equal(body.settings.aiAccess.projectFiles, false);
    const reload = await fetch(url, { headers });
    assert.equal(reload.status, 200);
    const reloaded = await reload.json() as { settings: { aiAccess: { projectFiles: boolean }; privacy: { projectList: boolean } } };
    assert.equal(reloaded.settings.privacy.projectList, false);
  } finally {
    await server.closeForShutdown();
  }
});
