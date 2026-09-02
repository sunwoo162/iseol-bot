import { randomBytes } from "node:crypto";

const SESSION_TTL_MS = 10 * 60 * 1000;

type GoogleOAuthSessionInput = {
  projectId: string;
  guildId: string;
  userId: string;
};

export type GoogleOAuthSession = GoogleOAuthSessionInput & {
  state: string;
  expiresAt: number;
};

const sessions = new Map<string, GoogleOAuthSession>();

export function buildGoogleOAuthRedirectUri(publicBaseUrl: string, configuredRedirectUri: string): string {
  const configured = configuredRedirectUri.trim();
  if (configured) return configured;
  const base = publicBaseUrl.trim().replace(/\/+$/, "");
  return base ? `${base}/google/oauth/callback` : "";
}

export function resolveGoogleRefreshToken(envRefreshToken: string, storedRefreshToken: string): string {
  return envRefreshToken.trim() || storedRefreshToken.trim();
}

export function googleOAuthConnectionState(input: {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  refreshToken: string;
}): "needs_admin" | "needs_authorization" | "ready" {
  if (!input.clientId.trim() || !input.clientSecret.trim() || !input.publicBaseUrl.trim()) return "needs_admin";
  return input.refreshToken.trim() ? "ready" : "needs_authorization";
}

export function createGoogleOAuthSession(input: GoogleOAuthSessionInput, now = Date.now()): GoogleOAuthSession {
  const session: GoogleOAuthSession = {
    ...input,
    state: randomBytes(24).toString("hex"),
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(session.state, session);
  return session;
}

export function consumeGoogleOAuthSession(state: string, now = Date.now()): GoogleOAuthSession | null {
  const session = sessions.get(state) ?? null;
  if (!session) return null;
  sessions.delete(state);
  return session.expiresAt >= now ? session : null;
}
