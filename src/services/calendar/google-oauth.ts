import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { google } from "googleapis";

const SESSION_TTL_MS = 10 * 60 * 1000;
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

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

export class GoogleOAuthTokenStore {
  constructor(private readonly path = "data/google-oauth.json") {}

  async getRefreshToken(): Promise<string> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { refreshToken?: unknown };
      return typeof parsed.refreshToken === "string" ? parsed.refreshToken.trim() : "";
    } catch (error: any) {
      if (error?.code === "ENOENT") return "";
      throw error;
    }
  }

  async saveRefreshToken(refreshToken: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ refreshToken: refreshToken.trim() }, null, 2) + "\n", "utf8");
  }
}

export function buildGoogleOAuthRedirectUri(publicBaseUrl: string, configuredRedirectUri: string): string {
  const configured = configuredRedirectUri.trim();
  if (configured) return configured;
  const base = publicBaseUrl.trim().replace(/\/+$/, "");
  return base ? `${base}/google/oauth/callback` : "";
}

export function buildGoogleAuthorizationUrl(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  state: string;
}): string {
  const oauth = new google.auth.OAuth2(input.clientId, input.clientSecret, input.redirectUri);
  return oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [CALENDAR_SCOPE],
    state: input.state,
  });
}

export async function exchangeGoogleAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<string> {
  const oauth = new google.auth.OAuth2(input.clientId, input.clientSecret, input.redirectUri);
  const { tokens } = await oauth.getToken(input.code);
  const refreshToken = tokens.refresh_token?.trim() ?? "";
  if (!refreshToken) {
    throw new Error("Google Calendar refresh token이 발급되지 않았습니다.");
  }
  return refreshToken;
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

export function googleCalendarConnectAction(input: {
  hasCalendar: boolean;
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
  refreshToken: string;
}): "connected" | "needs_admin" | "authorize" | "create" {
  if (input.hasCalendar) return "connected";
  const state = googleOAuthConnectionState(input);
  if (state === "needs_admin") return "needs_admin";
  return state === "needs_authorization" ? "authorize" : "create";
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
