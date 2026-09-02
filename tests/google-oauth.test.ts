import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoogleOAuthTokenStore,
  buildGoogleAuthorizationUrl,
  buildGoogleOAuthRedirectUri,
  createGoogleOAuthSession,
  consumeGoogleOAuthSession,
  googleOAuthConnectionState,
  resolveGoogleRefreshToken,
} from "../src/services/calendar/google-oauth.js";

test("google oauth redirect uri derives from public base url", () => {
  assert.equal(
    buildGoogleOAuthRedirectUri("https://iseol.example.com/", ""),
    "https://iseol.example.com/google/oauth/callback",
  );
  assert.equal(
    buildGoogleOAuthRedirectUri("https://ignored.example.com", "https://custom.example.com/callback"),
    "https://custom.example.com/callback",
  );
});

test("stored refresh token is used when env token is absent", () => {
  assert.equal(resolveGoogleRefreshToken("env-token", "stored-token"), "env-token");
  assert.equal(resolveGoogleRefreshToken("", "stored-token"), "stored-token");
  assert.equal(resolveGoogleRefreshToken("", ""), "");
});

test("google oauth state distinguishes admin setup from user authorization", () => {
  assert.equal(googleOAuthConnectionState({ clientId: "", clientSecret: "", publicBaseUrl: "https://iseol.example.com", refreshToken: "" }), "needs_admin");
  assert.equal(googleOAuthConnectionState({ clientId: "id", clientSecret: "secret", publicBaseUrl: "", refreshToken: "" }), "needs_admin");
  assert.equal(googleOAuthConnectionState({ clientId: "id", clientSecret: "secret", publicBaseUrl: "https://iseol.example.com", refreshToken: "" }), "needs_authorization");
  assert.equal(googleOAuthConnectionState({ clientId: "id", clientSecret: "secret", publicBaseUrl: "https://iseol.example.com", refreshToken: "token" }), "ready");
});

test("google oauth session is one-time and expires", () => {
  const now = 1_000_000;
  const session = createGoogleOAuthSession({ projectId: "p1", guildId: "g1", userId: "u1" }, now);
  assert.equal(consumeGoogleOAuthSession(session.state, now + 9 * 60_000)?.projectId, "p1");
  assert.equal(consumeGoogleOAuthSession(session.state, now + 9 * 60_000), null);

  const expired = createGoogleOAuthSession({ projectId: "p2", guildId: "g1", userId: "u1" }, now);
  assert.equal(consumeGoogleOAuthSession(expired.state, now + 11 * 60_000), null);
});

test("google authorization url requests offline calendar access with csrf state", () => {
  const url = new URL(buildGoogleAuthorizationUrl({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://iseol.example.com/google/oauth/callback",
    state: "state-123",
  }));
  assert.equal(url.hostname, "accounts.google.com");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "state-123");
  assert.match(url.searchParams.get("scope") ?? "", /googleapis\.com\/auth\/calendar/);
});

test("google oauth token store persists only the refresh token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "iseol-google-oauth-"));
  try {
    const store = new GoogleOAuthTokenStore(join(dir, "google-oauth.json"));
    assert.equal(await store.getRefreshToken(), "");
    await store.saveRefreshToken("refresh-123");
    assert.equal(await store.getRefreshToken(), "refresh-123");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
