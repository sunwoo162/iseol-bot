import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  createSession as createIdentitySession,
  createUser as createIdentityUser,
  resolvePrincipal,
  revokeSessionsForUser,
  revokeSession as revokeIdentitySession,
} from "../identity/store.js";
import { assertIdentityId, assertTimestamp, type Principal } from "../identity/contracts.js";
import { assertScopeAccess } from "../access/authorization.js";
import type { PlatformUserInput, PlatformUserRecord, PlatformUserService } from "./contracts.js";
import { withDurablePlatformUserLock } from "./user-lock.js";
import { listPlatformUsers, loadPasswordCredential, loadPlatformUser, savePasswordCredential, savePlatformUser } from "./store.js";

function validEmail(email: string): boolean {
  return email.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generatedUserId(): string {
  return `user-${randomUUID()}`;
}

function passwordHash(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 64);
}

function validPassword(password: string): boolean {
  return password.length >= 8 && password.length <= 256;
}

export function createPlatformUserService(root: string, options: { now?: () => string } = {}): PlatformUserService {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async createUser(input: PlatformUserInput): Promise<PlatformUserRecord> {
      const id = input.id ?? generatedUserId();
      assertIdentityId(id);
      if (!validEmail(input.email.trim())) throw new Error("Valid user email is required");
      if (!input.displayName.trim()) throw new Error("User display name is required");
      if (!input.timezone.trim()) throw new Error("User timezone is required");
      if (input.password !== undefined && !validPassword(input.password)) throw new Error("Password must be between 8 and 256 characters");
      return withDurablePlatformUserLock(root, id, async () => {
        const at = now();
        assertTimestamp(at, "user timestamp");
        const existing = await loadPlatformUser(root, id);
        if (existing) {
          if (existing.email !== input.email || existing.displayName !== input.displayName || existing.timezone !== input.timezone) {
            throw new Error("Platform user already exists with different data");
          }
          return existing;
        }
        await createIdentityUser(root, { id, timezone: input.timezone, at });
        const user: PlatformUserRecord = {
          version: 1,
          id,
          email: input.email,
          displayName: input.displayName,
          timezone: input.timezone,
          createdAt: at,
          updatedAt: at,
        };
        await savePlatformUser(root, user);
        if (input.password !== undefined) {
          const salt = randomBytes(16);
          await savePasswordCredential(root, id, { version: 1, salt: salt.toString("base64"), hash: passwordHash(input.password, salt).toString("base64"), createdAt: at });
        }
        return user;
      }, { waitForMs: 2_000 });
    },

    async getUser(userId: string): Promise<PlatformUserRecord | null> {
      try { assertIdentityId(userId); } catch { return null; }
      return loadPlatformUser(root, userId);
    },

    async listUsers(): Promise<PlatformUserRecord[]> {
      return listPlatformUsers(root);
    },

    async findUserByEmail(email: string): Promise<PlatformUserRecord | null> {
      const normalized = email.trim().toLowerCase();
      if (!validEmail(normalized)) return null;
      const users = await listPlatformUsers(root);
      return users.find((user) => user.email.trim().toLowerCase() === normalized) ?? null;
    },

    async authenticateUser(email: string, password: string): Promise<PlatformUserRecord | null> {
      if (!validPassword(password)) return null;
      const user = await this.findUserByEmail(email);
      if (!user) return null;
      const credential = await loadPasswordCredential(root, user.id);
      if (!credential || credential.version !== 1) return null;
      try {
        const salt = Buffer.from(credential.salt, "base64");
        const expected = Buffer.from(credential.hash, "base64");
        const actual = passwordHash(password, salt);
        return expected.length === actual.length && timingSafeEqual(expected, actual) ? user : null;
      } catch {
        return null;
      }
    },

    async changePassword(principal: Principal, currentPassword: string, newPassword: string): Promise<void> {
      if (!validPassword(currentPassword)) throw new Error("Current password is invalid");
      if (!validPassword(newPassword)) throw new Error("Password must be between 8 and 256 characters");
      await withDurablePlatformUserLock(root, principal.userId, async () => {
        const user = await loadPlatformUser(root, principal.userId);
        const credential = user ? await loadPasswordCredential(root, user.id) : null;
        if (!user || !credential || credential.version !== 1) throw new Error("Current password is invalid");
        try {
          const salt = Buffer.from(credential.salt, "base64");
          const expected = Buffer.from(credential.hash, "base64");
          const actual = passwordHash(currentPassword, salt);
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("Current password is invalid");
        } catch (error) {
          if (error instanceof Error && error.message === "Current password is invalid") throw error;
          throw new Error("Current password is invalid");
        }
        const at = now();
        assertTimestamp(at, "password timestamp");
        const salt = randomBytes(16);
        await savePasswordCredential(root, user.id, { version: 1, salt: salt.toString("base64"), hash: passwordHash(newPassword, salt).toString("base64"), createdAt: at });
        await revokeSessionsForUser(root, user.id, at);
      }, { waitForMs: 2_000 });
    },

    async createSession(input: { userId: string; roles: string[]; expiresAt: string }) {
      const user = await loadPlatformUser(root, input.userId);
      if (!user) throw new Error("Platform user does not exist");
      const at = now();
      const token = randomBytes(32).toString("hex");
      await createIdentitySession(root, { id: token, userId: input.userId, roles: input.roles, expiresAt: input.expiresAt, at });
      return { id: token, token, userId: input.userId, roles: [...input.roles], createdAt: at, expiresAt: input.expiresAt };
    },

    async revokeSession(sessionId: string, at = now()): Promise<void> {
      await revokeIdentitySession(root, sessionId, at);
    },

    async resolveAuthenticatedPrincipal(token: string, at = now()): Promise<Principal | null> {
      if (!token || token.length > 128) return null;
      return resolvePrincipal(root, token, at);
    },

    assertScopeAccess(principal, scope, action, memberUserIds = []): void {
      assertScopeAccess(principal, { scope, memberUserIds }, action);
    },
  };
}
