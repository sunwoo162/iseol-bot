import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createIntegrationService } from "../src/integrations/service.js";
import { routeIntegrationsRequest } from "../src/integrations/router.js";
import { createPlatformUserService } from "../src/platform-user/service.js";
import { createSettingsService } from "../src/settings/service.js";

test("user integration status and delivery route remain authenticated, owner-scoped, and truthful", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-integrations-api-"));
  const users = createPlatformUserService(join(root, "platform"), { now: () => "2026-09-28T00:00:00.000Z" });
  const settings = createSettingsService(join(root, "platform"), { now: () => "2026-09-28T00:00:00.000Z" });
  const integrations = createIntegrationService(join(root, "platform"), {
    now: () => "2026-09-28T00:00:00.000Z",
    isOptedIn: async (userId, provider) => (await settings.getSettings({ userId, sessionId: "integration-settings", roles: [] })).integrations[provider],
  });
  const userA = await users.createUser({ id: "integration-user-a", email: "integration-a@example.com", displayName: "A", timezone: "Asia/Seoul" });
  const userB = await users.createUser({ id: "integration-user-b", email: "integration-b@example.com", displayName: "B", timezone: "Asia/Seoul" });
  const sessionA = await users.createSession({ userId: userA.id, roles: ["user"], expiresAt: "2026-09-29T00:00:00.000Z" });
  const sessionB = await users.createSession({ userId: userB.id, roles: ["user"], expiresAt: "2026-09-29T00:00:00.000Z" });
  const services = { platformUserService: users, settingsService: settings, integrationService: integrations };
  const get = (token: string) => routeIntegrationsRequest({ method: "GET", path: "/api/user/integrations", headers: { authorization: `Bearer ${token}` } }, services);
  try {
    assert.equal((await get(sessionA.token)).status, 200);
    const initial = await get(sessionA.token);
    assert.deepEqual((initial.body as { integrations: Array<{ provider: string; optedIn: boolean; configured: boolean; lastDelivery: unknown }> }).integrations, [
      { provider: "calendar", optedIn: false, configured: false, lastDelivery: null },
      { provider: "github", optedIn: false, configured: false, lastDelivery: null },
      { provider: "discord", optedIn: false, configured: false, lastDelivery: null },
    ]);
    assert.equal((await get("bad-token")).status, 401);

    const settingsResponse = await (await import("../src/settings/router.js")).routeSettingsRequest({
      method: "PATCH",
      path: "/api/user/settings",
      headers: { authorization: `Bearer ${sessionA.token}` },
      body: { integrations: { github: true } },
    }, { platformUserService: users, settingsService: settings });
    assert.equal(settingsResponse.status, 200);

    const deliveryResponse = await routeIntegrationsRequest({
      method: "POST",
      path: "/api/user/integrations/github/deliveries",
      headers: { authorization: `Bearer ${sessionA.token}` },
      body: { sourceType: "project.lifecycle", sourceId: "project-a", eventType: "project.completed", eventVersion: 1 },
    }, services);
    assert.equal(deliveryResponse.status, 200);
    assert.equal((deliveryResponse.body as { delivery: { state: string; reason: string } }).delivery.state, "not-configured");
    assert.equal((await get(sessionB.token)).body instanceof Object, true);
    const userBStatus = (await get(sessionB.token)).body as { integrations: Array<{ provider: string; optedIn: boolean; lastDelivery: unknown }> };
    assert.equal(userBStatus.integrations.find((item) => item.provider === "github")?.optedIn, false);
    assert.equal(userBStatus.integrations.find((item) => item.provider === "github")?.lastDelivery, null);
  } finally {
    // The temporary root is intentionally left to the process cleanup boundary used by the existing API tests.
  }
});
