import { randomUUID } from "node:crypto";
import { assertIdentityId, assertTimestamp, type Principal } from "../identity/contracts.js";
import type { TeamCapability, TeamMembership } from "../teams/contracts.js";
import type { AiTeamProposal, AiTeamProposalDraft, AiTeamProposalService, AiTeamProposalServiceOptions } from "./contracts.js";
import { withDurableAiTeamProposalLock } from "./proposal-lock.js";
import { listAiTeamProposals, loadAiTeamProposal, saveAiTeamProposal } from "./store.js";
import { createUserRuntimeDispatchGate } from "../runtime/user-runtime-dispatch-gate.js";

function ensurePrincipal(principal: Principal): void { assertIdentityId(principal.userId); }
function required(value: string, label: string, max: number): string { const result = value.trim(); if (!result || result.length > max) throw new Error(label + " is required"); return result; }
function boundedCriteria(values: string[]): string[] { if (values.length > 8) throw new Error("AI team proposal has too many acceptance criteria"); return values.map((value) => required(value, "Acceptance criterion", 300)); }
function validateDraft(draft: AiTeamProposalDraft): AiTeamProposalDraft { return { title: required(draft.title, "AI proposal title", 160), objective: required(draft.objective, "AI proposal objective", 4_000), acceptanceCriteria: boundedCriteria(draft.acceptanceCriteria), rationale: required(draft.rationale, "AI proposal rationale", 1_000) }; }
async function projectAccess(options: AiTeamProposalServiceOptions, principal: Principal, projectId: string, manager = false): Promise<{ projectId: string; teamId: string; members: TeamMembership[] }> {
  const view = await options.userProjectService.getProject(principal, projectId);
  if (!view) throw new Error("Project not found");
  const teamId = view.project.teamId;
  if (!teamId || !["ai", "mixed"].includes(view.project.teamMode)) throw new Error("AI team project is required");
  const members = await options.teamService.listMemberships(teamId);
  const human = members.find((member) => member.memberType === "human" && member.userId === principal.userId && member.status === "active");
  if (!human) throw new Error("Team member access required");
  if (manager && !await options.teamService.isManager(principal, teamId)) throw new Error("Team manager access required");
  return { projectId, teamId, members };
}
function aiAssignment(members: TeamMembership[], agentId: string): TeamMembership {
  const member = members.find((item) => item.memberType === "ai" && item.status === "active" && item.aiMemberId === agentId);
  if (!member) throw new Error("AI team member not found");
  if (!member.capabilities.includes("task.propose") && !member.capabilities.includes("discussion.propose")) throw new Error("AI team proposal capability required");
  return member;
}
function waitingProposal(input: { projectId: string; teamId: string; agent: TeamMembership; requestId: string; at: string; blocker: string }): AiTeamProposal {
  return { version: 1, id: "ai-proposal-" + randomUUID(), projectId: input.projectId, teamId: input.teamId, agentId: input.agent.aiMemberId!, assignmentRole: input.agent.assignmentRole, capabilities: [...input.agent.capabilities], approvalScope: input.agent.approvalScope, requestId: input.requestId, title: "AI 작업 제안 대기", objective: "로컬 Runtime 제안 결과를 기다리는 중", acceptanceCriteria: [], rationale: "아직 제안 결과를 받지 못했습니다.", status: "waiting-runtime", source: "local-runtime", blocker: input.blocker, createdAt: input.at, updatedAt: input.at };
}
export function createAiTeamProposalService(options: AiTeamProposalServiceOptions): AiTeamProposalService {
  const now = options.now ?? (() => new Date().toISOString());
  const dispatchForUser = options.dispatchForUser ?? createUserRuntimeDispatchGate();
  return {
    async requestProposal(principal, projectId, input) {
      ensurePrincipal(principal); assertIdentityId(projectId); const requestId = required(input.requestId, "AI proposal requestId", 160); const agentId = required(input.agentId, "AI agentId", 128); const context = await projectAccess(options, principal, projectId); const agent = aiAssignment(context.members, agentId);
      return withDurableAiTeamProposalLock(options.root, projectId, requestId, async () => {
        const existing = (await listAiTeamProposals(options.root, projectId)).find((item) => item.requestId === requestId);
        if (existing) { if (existing.agentId !== agentId) throw new Error("AI proposal requestId conflict"); return existing; }
        const at = now(); assertTimestamp(at, "AI proposal timestamp");
        if (!options.dispatcher) { const waiting = waitingProposal({ projectId, teamId: context.teamId, agent, requestId, at, blocker: "AI Team Runtime is not configured" }); await saveAiTeamProposal(options.root, waiting); return waiting; }
        try {
          const result = await dispatchForUser(principal.userId, () => options.dispatcher!({ principal, projectId, teamId: context.teamId, agentId, assignmentRole: agent.assignmentRole, capabilities: [...agent.capabilities] as TeamCapability[] }));
          if (result.status === "waiting") { const waiting = waitingProposal({ projectId, teamId: context.teamId, agent, requestId, at, blocker: required(result.blocker, "AI proposal blocker", 240) }); await saveAiTeamProposal(options.root, waiting); return waiting; }
          const draft = validateDraft(result.draft); const proposal: AiTeamProposal = { version: 1, id: "ai-proposal-" + randomUUID(), projectId, teamId: context.teamId, agentId, assignmentRole: agent.assignmentRole, capabilities: [...agent.capabilities], approvalScope: agent.approvalScope, requestId, ...draft, status: "proposed", source: "local-runtime", createdAt: at, updatedAt: at }; await saveAiTeamProposal(options.root, proposal); return proposal;
        } catch (error) { const blocker = error instanceof Error ? error.message.slice(0, 240) : "AI Team Runtime proposal failed"; const waiting = waitingProposal({ projectId, teamId: context.teamId, agent, requestId, at, blocker }); await saveAiTeamProposal(options.root, waiting); return waiting; }
      }, { waitForMs: 2_000 });
    },
    async listProposals(principal, projectId) { ensurePrincipal(principal); await projectAccess(options, principal, projectId); return listAiTeamProposals(options.root, projectId); },
    async acceptProposal(principal, projectId, proposalId) {
      ensurePrincipal(principal); assertIdentityId(projectId); assertIdentityId(proposalId); await projectAccess(options, principal, projectId, true); const current = await loadAiTeamProposal(options.root, projectId, proposalId); if (!current) throw new Error("AI team proposal not found");
      if (current.status === "accepted" && current.workRequestId) { const view = await options.userProjectService.getProject(principal, projectId); const workRequest = view?.workRequests.find((item) => item.id === current.workRequestId); if (workRequest) return { proposal: current, workRequest }; throw new Error("Accepted AI proposal work request not found"); }
      if (current.status !== "proposed") throw new Error("AI team proposal is " + current.status);
      const result = await options.userProjectService.createWorkRequest(principal, projectId, { title: current.title, objective: current.objective, idempotencyKey: "ai-proposal:" + current.id });
      const at = now(); assertTimestamp(at, "AI proposal acceptance timestamp"); const proposal = { ...current, status: "accepted" as const, workRequestId: result.request.id, updatedAt: at }; await saveAiTeamProposal(options.root, proposal);
      await options.activityService?.recordActivityEvent(principal, {
        sourceType: "ai-team-proposal",
        sourceId: proposal.id,
        eventType: "ai.team.proposal.accepted",
        eventVersion: 1,
        actorType: "user",
        verificationStatus: "unverified",
        payload: { projectId, teamId: proposal.teamId, proposalId: proposal.id, workRequestId: result.request.id, agentId: proposal.agentId },
        occurredAt: at,
      });
      return { proposal, workRequest: result.request };
    },
    async rejectProposal(principal, projectId, proposalId) { ensurePrincipal(principal); assertIdentityId(projectId); assertIdentityId(proposalId); await projectAccess(options, principal, projectId, true); const current = await loadAiTeamProposal(options.root, projectId, proposalId); if (!current) throw new Error("AI team proposal not found"); if (current.status === "rejected") return current; if (current.status !== "proposed") throw new Error("AI team proposal is " + current.status); const at = now(); assertTimestamp(at, "AI proposal rejection timestamp"); const proposal = { ...current, status: "rejected" as const, updatedAt: at }; await saveAiTeamProposal(options.root, proposal); return proposal; },
  };
}
