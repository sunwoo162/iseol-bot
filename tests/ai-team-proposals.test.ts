import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { Principal } from "../src/identity/contracts.js";
import { createTeamService } from "../src/teams/service.js";
import { createUserProjectService } from "../src/project-model/user-project-service.js";
import { createAiTeamProposalService } from "../src/ai-team/service.js";

const at = "2026-09-27T12:00:00.000Z";
function principal(userId: string): Principal { return { userId, sessionId: `session-${userId}`, roles: ["user"] }; }

test("AI team proposals require a bounded assigned capability and human acceptance before a work request exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-ai-team-proposal-"));
  const owner = principal("proposal-owner");
  const outsider = principal("proposal-outsider");
  const teams = createTeamService(join(root, "platform"), { now: () => at });
  const team = await teams.createTeam(owner, { name: "AI delivery team", description: "bounded AI collaboration", kind: "project", visibility: "public", capacity: 5 });
  await teams.addAiMember(owner, team.id, { agentId: "frontend", assignmentRole: "frontend", capabilities: ["context.read", "task.propose"], approvalScope: "owner-approved-execution" }, at);
  const projects = createUserProjectService({ platformRoot: join(root, "platform"), projectModelRoot: join(root, "projects"), projectHarnessRoot: join(root, "runs"), iseolRoot: root, canAccessTeam: (subject, teamId) => teams.canAccess(subject, teamId), now: () => at });
  const project = await projects.createProject(owner, { name: "AI proposal project", objective: "connect bounded proposals", purpose: "rapid-prototype", teamMode: "mixed", teamId: team.id });
  const proposalService = createAiTeamProposalService({ root: join(root, "ai-team"), teamService: teams, userProjectService: projects, now: () => at, dispatcher: async () => ({ status: "proposed", draft: { title: "Create typed client", objective: "Add a typed client boundary", acceptanceCriteria: ["API types compile", "scope remains owner-bound"], rationale: "Reduce integration drift" } }) });

  await assert.rejects(() => proposalService.requestProposal(outsider, project.id, { agentId: "frontend", requestId: "foreign-request" }), /team member|access/i);
  const proposal = await proposalService.requestProposal(owner, project.id, { agentId: "frontend", requestId: "proposal-1" });
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.assignmentRole, "frontend");
  assert.deepEqual(proposal.acceptanceCriteria, ["API types compile", "scope remains owner-bound"]);
  assert.equal(proposal.workRequestId, undefined);
  assert.equal((await projects.getProject(owner, project.id))?.workRequests.length, 0);

  const accepted = await proposalService.acceptProposal(owner, project.id, proposal.id);
  assert.equal(accepted.proposal.status, "accepted");
  assert.equal(accepted.workRequest.status, "queued");
  assert.equal(accepted.proposal.workRequestId, accepted.workRequest.id);
  const repeated = await proposalService.acceptProposal(owner, project.id, proposal.id);
  assert.equal(repeated.workRequest.id, accepted.workRequest.id);
  const reloaded = createAiTeamProposalService({ root: join(root, "ai-team"), teamService: teams, userProjectService: projects, now: () => at });
  assert.equal((await reloaded.listProposals(owner, project.id))[0]?.status, "accepted");
});

test("AI team proposal without a local dispatcher is durable waiting and does not fabricate a task", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-ai-team-waiting-"));
  const owner = principal("waiting-owner");
  const teams = createTeamService(join(root, "platform"), { now: () => at });
  const team = await teams.createTeam(owner, { name: "Waiting AI team", description: "waiting boundary", kind: "project", visibility: "private", capacity: 3 });
  await teams.addAiMember(owner, team.id, { agentId: "qa", assignmentRole: "qa", capabilities: ["discussion.propose"], approvalScope: "suggestion-only" }, at);
  const projects = createUserProjectService({ platformRoot: join(root, "platform"), projectModelRoot: join(root, "projects"), projectHarnessRoot: join(root, "runs"), iseolRoot: root, canAccessTeam: (subject, teamId) => teams.canAccess(subject, teamId), now: () => at });
  const project = await projects.createProject(owner, { name: "Waiting proposal project", objective: "preserve no-runtime state", purpose: "portfolio", teamMode: "mixed", teamId: team.id });
  const proposalService = createAiTeamProposalService({ root: join(root, "ai-team"), teamService: teams, userProjectService: projects, now: () => at });
  const waiting = await proposalService.requestProposal(owner, project.id, { agentId: "qa", requestId: "waiting-1" });
  assert.equal(waiting.status, "waiting-runtime");
  assert.match(waiting.blocker ?? "", /Runtime/i);
  assert.equal((await projects.getProject(owner, project.id))?.workRequests.length, 0);
});

test("concurrent AI team proposal requests across service instances remain one proposal", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-ai-team-proposal-concurrent-"));
  const owner = principal("proposal-concurrent-owner");
  const teams = createTeamService(join(root, "platform"), { now: () => at });
  const team = await teams.createTeam(owner, { name: "Concurrent AI team", description: "proposal idempotency", kind: "project", visibility: "public", capacity: 5 });
  await teams.addAiMember(owner, team.id, { agentId: "frontend", assignmentRole: "frontend", capabilities: ["context.read", "task.propose"], approvalScope: "owner-approved-execution" }, at);
  const projects = createUserProjectService({ platformRoot: join(root, "platform"), projectModelRoot: join(root, "projects"), projectHarnessRoot: join(root, "runs"), iseolRoot: root, canAccessTeam: (subject, teamId) => teams.canAccess(subject, teamId), now: () => at });
  const project = await projects.createProject(owner, { name: "Concurrent proposal project", objective: "one durable proposal", purpose: "rapid-prototype", teamMode: "mixed", teamId: team.id });
  let dispatchCount = 0;
  const dispatcher = async () => {
    dispatchCount += 1;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    return { status: "proposed" as const, draft: { title: "Create typed client", objective: "Add one typed boundary", acceptanceCriteria: ["types compile"], rationale: "keep scope bounded" } };
  };
  const firstService = createAiTeamProposalService({ root: join(root, "ai-team"), teamService: teams, userProjectService: projects, now: () => at, dispatcher });
  const secondService = createAiTeamProposalService({ root: join(root, "ai-team"), teamService: teams, userProjectService: projects, now: () => at, dispatcher });

  const results = await Promise.all([
    firstService.requestProposal(owner, project.id, { agentId: "frontend", requestId: "concurrent-proposal" }),
    secondService.requestProposal(owner, project.id, { agentId: "frontend", requestId: "concurrent-proposal" }),
  ]);

  assert.equal(dispatchCount, 1);
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal((await firstService.listProposals(owner, project.id)).length, 1);
});

test("concurrent AI team proposal decisions keep one terminal decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-ai-team-proposal-decision-concurrent-"));
  const owner = principal("proposal-decision-concurrent-owner");
  const teams = createTeamService(join(root, "platform"), { now: () => at });
  const team = await teams.createTeam(owner, { name: "Decision AI team", description: "proposal decision serialization", kind: "project", visibility: "public", capacity: 5 });
  await teams.addAiMember(owner, team.id, { agentId: "frontend", assignmentRole: "frontend", capabilities: ["context.read", "task.propose"], approvalScope: "owner-approved-execution" }, at);
  const projects = createUserProjectService({ platformRoot: join(root, "platform"), projectModelRoot: join(root, "projects"), projectHarnessRoot: join(root, "runs"), iseolRoot: root, canAccessTeam: (subject, teamId) => teams.canAccess(subject, teamId), now: () => at });
  const project = await projects.createProject(owner, { name: "Decision proposal project", objective: "one decision", purpose: "rapid-prototype", teamMode: "mixed", teamId: team.id });
  const firstService = createAiTeamProposalService({ root: join(root, "ai-team"), teamService: teams, userProjectService: projects, now: () => at, dispatcher: async () => ({ status: "proposed" as const, draft: { title: "One task", objective: "One bounded task", acceptanceCriteria: ["types compile"], rationale: "keep scope bounded" } }) });
  const secondService = createAiTeamProposalService({ root: join(root, "ai-team"), teamService: teams, userProjectService: projects, now: () => at });
  const proposal = await firstService.requestProposal(owner, project.id, { agentId: "frontend", requestId: "decision-race" });

  const results = await Promise.allSettled([
    firstService.acceptProposal(owner, project.id, proposal.id),
    secondService.rejectProposal(owner, project.id, proposal.id),
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && /proposal|status|accepted|rejected/i.test(String(result.reason))).length, 1);
  const stored = (await firstService.listProposals(owner, project.id))[0];
  assert.ok(stored?.status === "accepted" || stored?.status === "rejected");
});
