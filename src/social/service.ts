import { randomUUID } from "node:crypto";
import { assertIdentityId, assertTimestamp, type Principal } from "../identity/contracts.js";
import type { FriendRequest, PublicProfile, SocialBlock, SocialProfile, SocialReport, SocialService, SocialServiceOptions } from "./contracts.js";
import { withDurableSocialBlockLock } from "./block-lock.js";
import { withDurableFriendRequestLock } from "./friend-request-lock.js";
import { withDurableSocialProfileLock } from "./profile-lock.js";
import { listBlocks, listDirectMessages, listFriendRequests, listReports, loadBlock, loadFriendRequest, loadProfile, saveBlock, saveDirectMessage, saveFriendRequest, saveProfile, saveReport } from "./store.js";

function ensurePrincipal(principal: Principal): void { assertIdentityId(principal.userId); }
function required(value: string, label: string, max: number): string { const trimmed = value.trim(); if (!trimmed || trimmed.length > max) throw new Error(`${label} is required`); return trimmed; }
function friendshipId(a: string, b: string): string { return `friend-${[a, b].sort().join("-")}`; }

export function createSocialService(root: string, options: SocialServiceOptions): SocialService {
  const now = options.now ?? (() => new Date().toISOString());
  const publicDetailsFor = async (userId: string): Promise<Pick<PublicProfile, "publicGrowth" | "publicProjects" | "publicLearning" | "publicPortfolio">> => {
    const details: Pick<PublicProfile, "publicGrowth" | "publicProjects" | "publicLearning" | "publicPortfolio"> = {};
    if (options.portfolioService) {
      try {
        details.publicPortfolio = (await options.portfolioService.listPublicEntries(userId)).map(({ id, title, summary, updatedAt }) => ({ id, title, summary, updatedAt }));
      } catch { /* Public projections fail closed when their source is unavailable. */ }
    }
    if (!options.settingsService) return details;
    const systemPrincipal: Principal = { userId, sessionId: "public-profile", roles: ["system"] };
    let privacy: { growthInfo: boolean; projectList: boolean; learningHistory: boolean };
    try {
      privacy = (await options.settingsService.getSettings(systemPrincipal)).privacy;
    } catch {
      return {};
    }
    if (privacy.growthInfo && options.growthService) {
      try {
        const snapshot = await options.growthService.getGrowthSnapshot(systemPrincipal);
        details.publicGrowth = {
          level: snapshot.level,
          xp: snapshot.xp,
          xpMax: snapshot.xpMax,
          stats: { ...snapshot.stats },
          achievements: snapshot.achievements.map(({ id, badgeKey, title, description, unlockedAt }) => ({ id, badgeKey, title, description, unlockedAt })),
        };
      } catch { /* Public projections fail closed when their source is unavailable. */ }
    }
    if (privacy.projectList && options.userProjectService) {
      try {
        const projects = await options.userProjectService.listProjects(systemPrincipal);
        details.publicProjects = projects
          .filter((project) => project.ownerUserId === userId)
          .map(({ name, objective, purpose, teamMode, status, createdAt, updatedAt }) => ({ name, objective, purpose, teamMode, status, createdAt, updatedAt }));
      } catch { /* Public projections fail closed when their source is unavailable. */ }
    }
    if (privacy.learningHistory && options.learningService) {
      try {
        const [goals, plans, sessions] = await Promise.all([
          options.learningService.listLearningGoals(systemPrincipal),
          options.learningService.listLearningPlans(systemPrincipal),
          options.learningService.listLearningSessions(systemPrincipal),
        ]);
        details.publicLearning = {
          goals: goals.map(({ input, status, updatedAt }) => ({ subject: input.subjectText, status, updatedAt })),
          plans: plans.map(({ title, status, updatedAt }) => ({ title, status, updatedAt })),
          sessions: sessions.map(({ status, startedAt, completedAt }) => ({ status, startedAt, ...(completedAt ? { completedAt } : {}) })),
        };
      } catch { /* Public projections fail closed when their source is unavailable. */ }
    }
    return details;
  };
  const profileFor = async (userId: string, includePublicDetails = false): Promise<PublicProfile | null> => {
    const user = await options.platformUserService.getUser(userId); if (!user) return null;
    const stored = await loadProfile(root, userId);
    const at = stored?.updatedAt ?? user.updatedAt;
    const profile: SocialProfile = stored ?? { version: 1, userId, handle: user.id, bio: "", skills: [], visibility: "public", createdAt: user.createdAt, updatedAt: at };
    return { ...profile, displayName: user.displayName, ...(includePublicDetails ? await publicDetailsFor(userId) : {}) };
  };
  const isAccepted = async (a: string, b: string): Promise<boolean> => { const request = await loadFriendRequest(root, friendshipId(a, b)); return request?.status === "accepted"; };
  const isBlocked = async (a: string, b: string): Promise<boolean> => (await loadBlock(root, a, b))?.status === "active" || (await loadBlock(root, b, a))?.status === "active";

  return {
    async updateProfile(principal, patch) {
      ensurePrincipal(principal); const user = await options.platformUserService.getUser(principal.userId); if (!user) throw new Error("User not found");
      return withDurableSocialProfileLock(root, principal.userId, async () => {
        const current = await loadProfile(root, principal.userId); const at = now(); assertTimestamp(at, "social profile timestamp");
        const handle = patch.handle === undefined ? current?.handle ?? user.id : required(patch.handle, "Profile handle", 80).replace(/[^A-Za-z0-9_.-]/g, "-");
        const skills = patch.skills === undefined ? current?.skills ?? [] : patch.skills.map((skill) => required(skill, "Profile skill", 80)).slice(0, 32);
        const visibility = patch.visibility ?? current?.visibility ?? "public"; if (!["public", "private"].includes(visibility)) throw new Error("Invalid profile visibility");
        const profile: SocialProfile = { version: 1, userId: principal.userId, handle, bio: patch.bio === undefined ? current?.bio ?? "" : patch.bio.trim().slice(0, 2_000), skills, visibility, createdAt: current?.createdAt ?? at, updatedAt: at };
        await saveProfile(root, profile); return { ...profile, displayName: user.displayName };
      }, { waitForMs: 2_000 });
    },
    async getProfile(principal, userId = principal.userId) {
      ensurePrincipal(principal);
      const read = async () => {
        if (userId !== principal.userId && await isBlocked(principal.userId, userId)) return null;
        const profile = await profileFor(userId, true);
        return profile && (profile.visibility === "public" || userId === principal.userId) ? profile : null;
      };
      return userId === principal.userId ? read() : withDurableSocialBlockLock(root, principal.userId, userId, read, { waitForMs: 2_000 });
    },
    async listProfiles(principal, search = "") {
      ensurePrincipal(principal); const users = await options.platformUserService.listUsers(); const query = search.trim().toLowerCase(); const profiles: PublicProfile[] = [];
      for (const user of users) {
        const profile = user.id === principal.userId
          ? await profileFor(user.id)
          : await withDurableSocialBlockLock(root, principal.userId, user.id, async () => {
              if (await isBlocked(principal.userId, user.id)) return null;
              return profileFor(user.id);
            }, { waitForMs: 2_000 });
        if (!profile || (profile.visibility !== "public" && profile.userId !== principal.userId)) continue;
        if (!query || `${profile.displayName} ${profile.handle} ${profile.skills.join(" ")}`.toLowerCase().includes(query)) profiles.push(profile);
      }
      return profiles.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId));
    },
    async listFriends(principal) {
      ensurePrincipal(principal); const requests = await listFriendRequests(root); const friends: PublicProfile[] = [];
      for (const request of requests.filter((item) => item.status === "accepted" && (item.requesterUserId === principal.userId || item.targetUserId === principal.userId))) {
        const other = request.requesterUserId === principal.userId ? request.targetUserId : request.requesterUserId;
        const profile = await withDurableSocialBlockLock(root, principal.userId, other, async () => {
          if (await isBlocked(principal.userId, other)) return null;
          return profileFor(other);
        }, { waitForMs: 2_000 });
        if (profile) friends.push(profile);
      }
      return friends.sort((a, b) => a.displayName.localeCompare(b.displayName));
    },
    async createFriendRequest(principal, targetUserId) {
      ensurePrincipal(principal); assertIdentityId(targetUserId); if (targetUserId === principal.userId) throw new Error("Cannot friend yourself"); if (!await options.platformUserService.getUser(targetUserId)) throw new Error("Target user not found");
      const id = friendshipId(principal.userId, targetUserId);
      return withDurableSocialBlockLock(root, principal.userId, targetUserId, async () => {
        if (await isBlocked(principal.userId, targetUserId)) throw new Error("User is blocked");
        return withDurableFriendRequestLock(root, id, async () => {
          const existing = await loadFriendRequest(root, id); if (existing?.status === "accepted" || existing?.status === "pending") return { request: existing, created: false };
          const at = now(); assertTimestamp(at, "friend request timestamp"); const request: FriendRequest = { version: 1, id, requesterUserId: principal.userId, targetUserId, status: "pending", createdAt: existing?.createdAt ?? at, updatedAt: at }; await saveFriendRequest(root, request); await options.activityService?.recordActivityEvent(principal, { sourceType: "social", sourceId: request.id, eventType: "friend.request.created", eventVersion: 1, actorType: "user", verificationStatus: "verified", payload: { targetUserId } }); return { request, created: true };
        }, { waitForMs: 2_000 });
      }, { waitForMs: 2_000 });
    },
    async listIncomingFriendRequests(principal) {
      ensurePrincipal(principal); const requests = await listFriendRequests(root); const result: Array<FriendRequest & { requester: PublicProfile | null }> = [];
      for (const request of requests.filter((item) => item.targetUserId === principal.userId && item.status === "pending")) {
        const visible = await withDurableSocialBlockLock(root, principal.userId, request.requesterUserId, async () => {
          if (await isBlocked(principal.userId, request.requesterUserId)) return null;
          return { ...request, requester: await profileFor(request.requesterUserId) };
        }, { waitForMs: 2_000 });
        if (visible) result.push(visible);
      }
      return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async respondToFriendRequest(principal, requestId, action) {
      ensurePrincipal(principal); assertIdentityId(requestId); if (!["accept", "reject"].includes(action)) throw new Error("Invalid friend request action");
      const initial = await loadFriendRequest(root, requestId);
      if (!initial || initial.targetUserId !== principal.userId) throw new Error("Friend request not found");
      return withDurableSocialBlockLock(root, initial.requesterUserId, initial.targetUserId, async () => {
        if (await isBlocked(initial.requesterUserId, initial.targetUserId)) throw new Error("User is blocked");
        return withDurableFriendRequestLock(root, requestId, async () => {
          const current = await loadFriendRequest(root, requestId); if (!current || current.targetUserId !== principal.userId || current.status !== "pending") throw new Error("Friend request not found"); const next: FriendRequest = { ...current, status: action === "accept" ? "accepted" : "rejected", updatedAt: now() }; await saveFriendRequest(root, next); await options.activityService?.recordActivityEvent(principal, { sourceType: "social", sourceId: next.id, eventType: `friend.request.${action === "accept" ? "accepted" : "rejected"}`, eventVersion: 1, actorType: "user", verificationStatus: "verified", payload: { requesterUserId: next.requesterUserId } }); return next;
        }, { waitForMs: 2_000 });
      }, { waitForMs: 2_000 });
    },
    async sendDirectMessage(principal, recipientUserId, body) {
      ensurePrincipal(principal);
      assertIdentityId(recipientUserId);
      if (recipientUserId === principal.userId || !await options.platformUserService.getUser(recipientUserId)) throw new Error("Recipient not found");
      return withDurableSocialBlockLock(root, principal.userId, recipientUserId, async () => {
        if (await isBlocked(principal.userId, recipientUserId)) throw new Error("User is blocked");
        const allowed = await isAccepted(principal.userId, recipientUserId) || await options.canCollaborate?.(principal.userId, recipientUserId) === true;
        if (!allowed) throw new Error("Direct messaging requires an accepted friendship or shared team");
        const at = now();
        assertTimestamp(at, "message timestamp");
        const message = { version: 1 as const, id: `message-${randomUUID()}`, senderUserId: principal.userId, recipientUserId, body: required(body, "Message", 10_000), createdAt: at };
        await saveDirectMessage(root, message);
        await options.activityService?.recordActivityEvent(principal, { sourceType: "social", sourceId: message.id, eventType: "message.sent", eventVersion: 1, actorType: "user", verificationStatus: "verified", payload: { recipientUserId } });
        if (options.notificationService) {
          const recipientSettings = options.settingsService
            ? await options.settingsService.getSettings({ userId: recipientUserId, sessionId: "social-message-notification", roles: ["system"] })
            : undefined;
          if (recipientSettings?.notifications.newMessage !== false) await options.notificationService.createDirectMessageNotification({ userId: recipientUserId, messageId: message.id, actorUserId: principal.userId, conversationUserId: principal.userId, createdAt: at });
        }
        return message;
      }, { waitForMs: 2_000 });
    },
    async listDirectMessages(principal, otherUserId) {
      ensurePrincipal(principal); assertIdentityId(otherUserId);
      return withDurableSocialBlockLock(root, principal.userId, otherUserId, async () => {
        if (await isBlocked(principal.userId, otherUserId)) throw new Error("User is blocked");
        const allowed = await isAccepted(principal.userId, otherUserId) || await options.canCollaborate?.(principal.userId, otherUserId) === true;
        if (!allowed) throw new Error("Direct messaging requires an accepted friendship or shared team");
        return (await listDirectMessages(root)).filter((message) => (message.senderUserId === principal.userId && message.recipientUserId === otherUserId) || (message.senderUserId === otherUserId && message.recipientUserId === principal.userId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      }, { waitForMs: 2_000 });
    },
    async blockUser(principal, targetUserId) {
      ensurePrincipal(principal); assertIdentityId(targetUserId); if (targetUserId === principal.userId) throw new Error("Cannot block yourself"); if (!await options.platformUserService.getUser(targetUserId)) throw new Error("Target user not found");
      return withDurableSocialBlockLock(root, principal.userId, targetUserId, async () => {
        const current = await loadBlock(root, principal.userId, targetUserId);
        if (current?.status === "active") return current;
        const at = now(); assertTimestamp(at, "block timestamp"); const block: SocialBlock = { version: 1, id: `block-${principal.userId}-${targetUserId}`, blockerUserId: principal.userId, blockedUserId: targetUserId, status: "active", createdAt: current?.createdAt ?? at, updatedAt: at }; await saveBlock(root, block); await options.activityService?.recordActivityEvent(principal, { sourceType: "social", sourceId: block.id, eventType: "social.block.created", eventVersion: 1, actorType: "user", verificationStatus: "unverified", payload: { targetUserId } }); return block;
      }, { waitForMs: 2_000 });
    },
    async unblockUser(principal, targetUserId) {
      ensurePrincipal(principal); assertIdentityId(targetUserId);
      return withDurableSocialBlockLock(root, principal.userId, targetUserId, async () => {
        const current = await loadBlock(root, principal.userId, targetUserId); if (!current || current.status !== "active") throw new Error("Block not found"); const at = now(); assertTimestamp(at, "unblock timestamp"); const block: SocialBlock = { ...current, status: "removed", updatedAt: at }; await saveBlock(root, block); return block;
      }, { waitForMs: 2_000 });
    },
    async listBlocks(principal) { ensurePrincipal(principal); return (await listBlocks(root)).filter((item) => item.blockerUserId === principal.userId && item.status === "active").sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
    async reportUser(principal, targetUserId, reason) {
      ensurePrincipal(principal); assertIdentityId(targetUserId); if (targetUserId === principal.userId) throw new Error("Cannot report yourself"); if (!await options.platformUserService.getUser(targetUserId)) throw new Error("Target user not found"); const at = now(); assertTimestamp(at, "report timestamp"); const report: SocialReport = { version: 1, id: `report-${randomUUID()}`, reporterUserId: principal.userId, targetUserId, reason: required(reason, "Report reason", 5_000), status: "open", createdAt: at, updatedAt: at }; await saveReport(root, report); await options.activityService?.recordActivityEvent(principal, { sourceType: "social", sourceId: report.id, eventType: "social.report.created", eventVersion: 1, actorType: "user", verificationStatus: "unverified", payload: { targetUserId } }); return report;
    },
    async listReports(principal) { ensurePrincipal(principal); return (await listReports(root)).filter((item) => item.reporterUserId === principal.userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
  };
}
