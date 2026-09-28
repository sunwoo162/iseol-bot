import { randomUUID } from "node:crypto";
import { assertIdentityId, assertTimestamp, type Principal } from "../identity/contracts.js";
import type { AiTeamMemberInput, TeamApprovalScope, TeamCapability, TeamInput, TeamListItem, TeamMembership, TeamMemberRole, TeamRecord, TeamService, TeamServiceOptions } from "./contracts.js";
import { listMemberships, listTeams, loadMembership, loadTeam, saveMembership, saveTeam } from "./store.js";

function ensurePrincipal(principal: Principal): void { assertIdentityId(principal.userId); }
function required(value: string, label: string, max: number): string { const trimmed = value.trim(); if (!trimmed || trimmed.length > max) throw new Error(`${label} is required`); return trimmed; }
function active(membership: TeamMembership | null | undefined): membership is TeamMembership { return membership?.status === "active"; }
const allowedCapabilities = new Set<TeamCapability>(["context.read", "discussion.propose", "task.propose", "execution.request"]);
function validateAiInput(input: AiTeamMemberInput): AiTeamMemberInput {
  assertIdentityId(input.agentId);
  const assignmentRole = required(input.assignmentRole, "AI assignment role", 120);
  if (!Array.isArray(input.capabilities) || input.capabilities.length < 1 || input.capabilities.length > 8 || input.capabilities.some((capability) => !allowedCapabilities.has(capability))) throw new Error("AI capabilities are invalid");
  const capabilities = [...new Set(input.capabilities)];
  if (!(["suggestion-only", "owner-approved-execution"] as TeamApprovalScope[]).includes(input.approvalScope)) throw new Error("AI approval scope is invalid");
  return { agentId: input.agentId, assignmentRole, capabilities, approvalScope: input.approvalScope };
}

export function createTeamService(root: string, options: TeamServiceOptions = {}): TeamService {
  const now = options.now ?? (() => new Date().toISOString());
  const getMembership = (teamId: string, userId: string) => loadMembership(root, teamId, userId);
  const isManagerByUser = async (teamId: string, userId: string): Promise<boolean> => {
    const team = await loadTeam(root, teamId);
    if (!team) return false;
    const membership = await getMembership(teamId, userId);
    return active(membership) && (membership.role === "owner" || membership.role === "admin");
  };

  return {
    async createTeam(principal, input: TeamInput) {
      ensurePrincipal(principal);
      if (!["project", "study"].includes(input.kind)) throw new Error("Invalid team kind");
      if (!["public", "private"].includes(input.visibility)) throw new Error("Invalid team visibility");
      if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 1000) throw new Error("Team capacity is invalid");
      const at = now(); assertTimestamp(at, "team timestamp");
      const team: TeamRecord = { version: 1, id: `team-${randomUUID()}`, ownerUserId: principal.userId, name: required(input.name, "Team name", 160), description: required(input.description, "Team description", 4_000), kind: input.kind, visibility: input.visibility, capacity: input.capacity, status: "active", createdAt: at, updatedAt: at };
      await saveTeam(root, team);
      await saveMembership(root, { version: 1, id: `${team.id}:${principal.userId}`, teamId: team.id, userId: principal.userId, memberType: "human", role: "owner", assignmentRole: "owner", capabilities: [], approvalScope: "suggestion-only", status: "active", joinedAt: at, updatedAt: at });
      await options.activityService?.recordActivityEvent(principal, { sourceType: "team", sourceId: team.id, eventType: "team.created", eventVersion: 1, actorType: "user", verificationStatus: "verified", payload: { kind: team.kind, visibility: team.visibility } });
      return team;
    },

    async listTeams(principal) {
      ensurePrincipal(principal);
      const teams = await listTeams(root);
      const result: TeamListItem[] = [];
      for (const team of teams) {
        if (team.status !== "active") continue;
        const membership = await getMembership(team.id, principal.userId);
        if (team.visibility === "public" || active(membership)) result.push({ ...team, ...(membership?.status === "active" ? { viewerRole: membership.role } : {}) });
      }
      return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    },

    async getTeam(principal, teamId) {
      ensurePrincipal(principal);
      try { assertIdentityId(teamId); } catch { return null; }
      const team = await loadTeam(root, teamId);
      if (!team || team.status !== "active") return null;
      const membership = await getMembership(teamId, principal.userId);
      if (team.visibility === "private" && !active(membership)) return null;
      return { team, members: (await listMemberships(root, teamId)).filter((item) => item.status === "active").sort((a, b) => a.joinedAt.localeCompare(b.joinedAt)) };
    },

    async listMemberships(teamId) { try { assertIdentityId(teamId); } catch { return []; } return (await listMemberships(root, teamId)).filter((item) => item.status === "active"); },

    async addMember(teamId, userId, role, at = now()) {
      assertIdentityId(teamId); assertIdentityId(userId); assertTimestamp(at, "membership timestamp");
      if (!["owner", "admin", "member"].includes(role)) throw new Error("Invalid team member role");
      const team = await loadTeam(root, teamId); if (!team || team.status !== "active") throw new Error("Team not found");
      const existing = await getMembership(teamId, userId);
      if (active(existing)) return existing;
      const members = (await listMemberships(root, teamId)).filter((item) => item.status === "active");
      if (members.length >= team.capacity) throw new Error("Team is full");
      const previousJoinedAt = (existing as TeamMembership | null)?.joinedAt;
      const membership: TeamMembership = { version: 1, id: `${teamId}:${userId}`, teamId, userId, memberType: "human", role, assignmentRole: role, capabilities: [], approvalScope: "suggestion-only", status: "active", joinedAt: previousJoinedAt ?? at, updatedAt: at };
      await saveMembership(root, membership);
      await saveTeam(root, { ...team, updatedAt: at });
      return membership;
    },

    async addAiMember(principal, teamId, input, at = now()) {
      ensurePrincipal(principal);
      if (!await isManagerByUser(teamId, principal.userId)) throw new Error("Team manager access required");
      assertIdentityId(teamId); assertTimestamp(at, "AI membership timestamp");
      const team = await loadTeam(root, teamId); if (!team || team.status !== "active") throw new Error("Team not found");
      const validated = validateAiInput(input);
      const userId = `ai-${validated.agentId}`;
      const existing = await getMembership(teamId, userId);
      const previousJoinedAt = existing?.joinedAt;
      if (active(existing)) return existing;
      const members = (await listMemberships(root, teamId)).filter((item) => item.status === "active");
      if (members.length >= team.capacity) throw new Error("Team is full");
      const membership: TeamMembership = { version: 1, id: `${team.id}:ai:${validated.agentId}`, teamId, userId, aiMemberId: validated.agentId, memberType: "ai", role: "member", assignmentRole: validated.assignmentRole, capabilities: [...validated.capabilities], approvalScope: validated.approvalScope, status: "active", joinedAt: previousJoinedAt ?? at, updatedAt: at };
      await saveMembership(root, membership);
      await saveTeam(root, { ...team, updatedAt: at });
      return membership;
    },

    async removeMember(principal, teamId, userId) {
      ensurePrincipal(principal);
      if (!await isManagerByUser(teamId, principal.userId)) throw new Error("Team manager access required");
      const team = await loadTeam(root, teamId); if (!team) throw new Error("Team not found");
      if (userId === team.ownerUserId) throw new Error("Team owner cannot be removed");
      const current = await getMembership(teamId, userId); if (!current || current.status !== "active" || current.memberType !== "human") throw new Error("Team member not found");
      const at = now(); const next = { ...current, status: "removed" as const, updatedAt: at }; await saveMembership(root, next); await options.activityService?.recordActivityEvent(principal, { sourceType: "team", sourceId: `${teamId}:${userId}`, eventType: "team.membership.removed", eventVersion: 1, actorType: "user", verificationStatus: "verified", payload: { teamId, memberUserId: userId } }); return next;
    },

    async removeAiMember(principal, teamId, agentId) {
      ensurePrincipal(principal); if (!await isManagerByUser(teamId, principal.userId)) throw new Error("Team manager access required");
      assertIdentityId(teamId); assertIdentityId(agentId);
      const current = await getMembership(teamId, `ai-${agentId}`); if (!current || current.status !== "active" || current.memberType !== "ai") throw new Error("AI team member not found");
      const at = now(); const next = { ...current, status: "removed" as const, updatedAt: at }; await saveMembership(root, next); return next;
    },

    async leaveTeam(principal, teamId) {
      ensurePrincipal(principal);
      const team = await loadTeam(root, teamId); if (!team) throw new Error("Team not found");
      if (team.ownerUserId === principal.userId) throw new Error("Team owner cannot leave");
      const current = await getMembership(teamId, principal.userId); if (!current || current.status !== "active") throw new Error("Team membership not found");
      const at = now(); const next = { ...current, status: "left" as const, updatedAt: at }; await saveMembership(root, next); await options.activityService?.recordActivityEvent(principal, { sourceType: "team", sourceId: `${teamId}:${principal.userId}`, eventType: "team.membership.left", eventVersion: 1, actorType: "user", verificationStatus: "verified", payload: { teamId } }); return next;
    },

    async isManager(principal, teamId) { ensurePrincipal(principal); return isManagerByUser(teamId, principal.userId); },
    async canAccess(principal, teamId) { ensurePrincipal(principal); const team = await loadTeam(root, teamId); if (!team || team.status !== "active") return false; return team.visibility === "public" || active(await getMembership(teamId, principal.userId)); },
    async canCollaborate(userA, userB) {
      assertIdentityId(userA); assertIdentityId(userB);
      const teams = await listTeams(root);
      for (const team of teams.filter((item) => item.status === "active")) {
        const members = await listMemberships(root, team.id);
        if (members.some((item) => item.memberType === "human" && item.userId === userA && item.status === "active") && members.some((item) => item.memberType === "human" && item.userId === userB && item.status === "active")) return true;
      }
      return false;
    },
  };
}
