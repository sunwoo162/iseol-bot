import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { HarnessEvidenceKind, HarnessRuntimeRunEnvelope } from "../harness/contracts.js";
import type { HarnessStageExecutor, HarnessStageExecutionResult } from "../harness/run-supervisor.js";
import type { DesktopJobResult, DesktopTaskPack } from "./contracts.js";
import { listOnlineDesktopAgents } from "./agent-registry.js";
import {
  acquireDesktopJobLease,
  completeDesktopJob,
  createDesktopJob,
  requeueDesktopJob,
} from "./job-store.js";

export interface DesktopExecutionTransport {
  isAgentConnected(agentId: string): boolean;
  getAgentSessionId(agentId: string): string | null;
  sendTask(agentId: string, pack: DesktopTaskPack): void;
  awaitResult(jobId: string, timeoutMs: number): Promise<DesktopJobResult>;
}

export type DesktopTaskCompiler = (
  run: HarnessRuntimeRunEnvelope,
  agentId: string,
) => Promise<DesktopTaskPack | null>;
export type CreateDesktopStageExecutorInput = {
  registryRoot: string;
  jobRoot: string;
  transport: DesktopExecutionTransport;
  compileTaskPack: DesktopTaskCompiler;
  now?: () => string;
  heartbeatTimeoutMs?: number;
  leaseDurationMs?: number;
  resultTimeoutMs?: number;
};

function containsPath(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveAgent(input: CreateDesktopStageExecutorInput, targetRoot: string, at: string) {
  const online = await listOnlineDesktopAgents(
    input.registryRoot,
    at,
    input.heartbeatTimeoutMs ?? 30_000,
  );
  return online.find((agent) =>
    input.transport.isAgentConnected(agent.agentId)
    && agent.workspaceRoots.some((root) => containsPath(root, targetRoot)),
  ) ?? null;
}
function evidenceKindForStage(stage: HarnessRuntimeRunEnvelope["state"]["stage"]): HarnessEvidenceKind {
  if (stage === "TEST") return "test";
  if (stage === "SELF_REVIEW") return "review";
  if (stage === "COMMIT") return "commit";
  if (stage === "PR") return "pull-request";
  if (stage === "CI") return "ci";
  if (stage === "DEPLOY") return "deployment";
  if (stage === "PRODUCTION_VERIFY") return "production-verification";
  return "command";
}

function completedResult(
  run: HarnessRuntimeRunEnvelope,
  result: DesktopJobResult,
): HarnessStageExecutionResult {
  const operationReference = result.operations.find((item) => item.reference)?.reference;
  return {
    type: "completed",
    evidence: [{
      version: 1,
      id: randomUUID(),
      kind: evidenceKindForStage(run.state.stage),
      stage: run.state.stage,
      recordedAt: result.completedAt,
      summary: `Desktop Job ${result.jobId} completed`,
      provider: "iseol-desktop-agent",
      reference: operationReference ?? `desktop-job:${result.jobId}`,
    }],
  };
}
function failureReason(result: DesktopJobResult): string {
  return result.operations.find((item) => !item.ok)?.summary
    ?? `Desktop Job ${result.jobId} returned ${result.status}`;
}

export function createDesktopStageExecutor(
  input: CreateDesktopStageExecutorInput,
): HarnessStageExecutor {
  const now = input.now ?? (() => new Date().toISOString());
  const leaseDurationMs = input.leaseDurationMs ?? 60_000;
  const resultTimeoutMs = input.resultTimeoutMs ?? 120_000;

  return {
    async execute(run): Promise<HarnessStageExecutionResult> {
      const at = now();
      const agent = await resolveAgent(input, run.request.targetRoot, at);
      if (!agent) return { type: "waiting-agent", reason: "No eligible Desktop Agent is online" };

      const compiled = await input.compileTaskPack(run, agent.agentId);
      if (!compiled) {
        return { type: "waiting-external", reason: `Desktop task intent is not available for ${run.state.stage}` };
      }
      if (compiled.runId !== run.request.runId || compiled.stage !== run.state.stage) {
        return { type: "final-failure", reason: "Desktop Task Pack does not match the active Run stage" };
      }
      if (compiled.agentId !== agent.agentId) {
        return { type: "final-failure", reason: "Desktop Task Pack targets a different Agent" };
      }

      const job = await createDesktopJob(input.jobRoot, compiled, at);
      if (job.status === "completed" && job.result) return completedResult(run, job.result);
      const sessionId = input.transport.getAgentSessionId(agent.agentId);
      if (!sessionId) return { type: "waiting-agent", reason: "Desktop Agent session is unavailable" };
      const leased = await acquireDesktopJobLease(
        input.jobRoot,
        job.jobId,
        sessionId,
        at,
        leaseDurationMs,
      );
      const dispatchPack: DesktopTaskPack = {
        ...leased.pack,
        attempt: leased.attempts,
        leaseUntil: leased.lease?.expiresAt ?? leased.pack.leaseUntil,
      };

      let result: DesktopJobResult;
      try {
        input.transport.sendTask(agent.agentId, dispatchPack);
        result = await input.transport.awaitResult(job.jobId, resultTimeoutMs);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await requeueDesktopJob(input.jobRoot, job.jobId, sessionId, now());
        return { type: "retryable-failure", reason };
      }

      if (result.status === "retryable-failure") {
        await requeueDesktopJob(input.jobRoot, job.jobId, sessionId, result.completedAt);
        return { type: "retryable-failure", reason: failureReason(result) };
      }

      await completeDesktopJob(input.jobRoot, job.jobId, sessionId, result);
      if (result.status === "blocked-user") {
        return { type: "blocked-user", reason: failureReason(result) };
      }
      if (result.status === "final-failure") {
        return { type: "final-failure", reason: failureReason(result) };
      }
      return completedResult(run, result);
    },
  };
}
