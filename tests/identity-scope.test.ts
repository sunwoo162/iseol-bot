import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createSession,
  createUser,
  resolvePrincipal,
  revokeSession,
} from "../src/identity/store.js";
import type { Principal } from "../src/identity/contracts.js";
import {
  authorizeResource,
  personalScope,
  scopeDirectory,
  teamScope,
} from "../src/access/authorization.js";

const at = "2026-09-25T12:00:00.000Z";

test("active sessions resolve to their stored user and revoke fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-identity-"));
  await createUser(root, { id: "user-a", timezone: "Asia/Seoul", at });
  await createSession(root, { id: "session-a", userId: "user-a", roles: ["user"], expiresAt: "2026-09-26T12:00:00.000Z", at });

  assert.deepEqual(await resolvePrincipal(root, "session-a", at), {
    userId: "user-a", sessionId: "session-a", roles: ["user"],
  });
  assert.equal(await resolvePrincipal(root, "session-a", "2026-09-27T12:00:00.000Z"), null);

  await revokeSession(root, "session-a", "2026-09-25T12:01:00.000Z");
  assert.equal(await resolvePrincipal(root, "session-a", "2026-09-25T12:02:00.000Z"), null);
});

test("personal scope paths stay inside the platform root and do not trust path-like ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-scope-path-"));
  assert.equal(scopeDirectory(root, personalScope("user-a")), resolve(root, "users", "user-a"));
  assert.equal(scopeDirectory(root, teamScope("team-a")), resolve(root, "teams", "team-a"));
  assert.throws(() => personalScope("../user-b"), /invalid/i);
  assert.throws(() => scopeDirectory(root, { kind: "personal", ownerUserId: "user-a/../../escape" }), /invalid/i);
});

test("resource authorization allows only the principal owner or an explicit team member", () => {
  const userA: Principal = { userId: "user-a", sessionId: "session-a", roles: ["user"] };
  const userB: Principal = { userId: "user-b", sessionId: "session-b", roles: ["user"] };
  assert.equal(authorizeResource(userA, { scope: personalScope("user-a") }), true);
  assert.equal(authorizeResource(userB, { scope: personalScope("user-a") }), false);
  assert.equal(authorizeResource(userA, { scope: personalScope("user-b") }), false);
  assert.equal(authorizeResource(userA, { scope: teamScope("team-a"), memberUserIds: ["user-a", "user-c"] }), true);
  assert.equal(authorizeResource(userB, { scope: teamScope("team-a"), memberUserIds: ["user-a", "user-c"] }), false);
});

test("team resources require explicit membership even when the request supplies another user id", () => {
  const principal: Principal = { userId: "user-a", sessionId: "session-a", roles: ["user"] };
  assert.equal(authorizeResource(principal, {
    scope: teamScope("team-a"),
    memberUserIds: ["user-b"],
    requestedUserId: "user-b",
  }), false);
});
