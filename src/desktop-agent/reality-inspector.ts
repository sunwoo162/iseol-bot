import type { HarnessRealityInspector, HarnessRealitySnapshot } from "../harness/recovery.js";
import type { HarnessRuntimeRunEnvelope } from "../harness/contracts.js";
import type { DesktopJobResult, DesktopTaskPack, GitCommitOperation } from "./contracts.js";
import { listOnlineDesktopAgents } from "./agent-registry.js";
import {
  acquireDesktopJobLease,
  completeDesktopJob,
  listDesktopJobs,
  listRecoverableDesktopJobs,
} from "./job-store.js";
import type { DesktopExecutionTransport } from "./desktop-executor.js";

export type CreateDesktopRealityInspectorInput = {
  registryRoot: string;
  jobRoot: string;
  transport: DesktopExecutionTransport;
  now?: () => string;
  heartbeatTimeoutMs?: number;
  inspectTimeoutMs?: number;
  leaseDurationMs?: number;
};

type GitIdentity = {
  head: string;
  parent: string;
  subject: string;
  branch: string;
  status: string;
  remoteHead?: string;
};
function commitOperation(pack: DesktopTaskPack): GitCommitOperation | null {
  const operation = pack.operations.find((item) => item.type === "GIT_COMMIT");
  return operation?.type === "GIT_COMMIT" ? operation : null;
}

function parseIdentity(result: DesktopJobResult): GitIdentity | null {
  if (result.status !== "completed") return null;
  const raw = result.operations.find((item) => item.operationId === "inspect")?.stdout;
  if (!raw) return null;
  try {
    const identity = JSON.parse(raw) as Partial<GitIdentity>;
    if (![identity.head, identity.parent, identity.subject, identity.branch, identity.status]
      .every((value) => typeof value === "string")) return null;
    return identity as GitIdentity;
  } catch {
    return null;
  }
}

function matchingRecoveredCommit(operation: GitCommitOperation, identity: GitIdentity): boolean {
  return Boolean(operation.expectedHead)
    && identity.parent === operation.expectedHead
    && identity.subject === operation.message
    && identity.status.trim() === ""
    && (!operation.publish || identity.remoteHead === identity.head);
}
export function createDesktopRealityInspector(
  input: CreateDesktopRealityInspectorInput,
): HarnessRealityInspector {
  const now = input.now ?? (() => new Date().toISOString());
  const heartbeatTimeoutMs = input.heartbeatTimeoutMs ?? 30_000;
  const inspectTimeoutMs = input.inspectTimeoutMs ?? 30_000;
  const leaseDurationMs = input.leaseDurationMs ?? 60_000;

  return {
    async inspect(run: HarnessRuntimeRunEnvelope): Promise<HarnessRealitySnapshot> {
      const at = now();
      const online = await listOnlineDesktopAgents(input.registryRoot, at, heartbeatTimeoutMs);
      const connected = online.filter((agent) => input.transport.isAgentConnected(agent.agentId));
      if (connected.length === 0) return { agentAvailable: false };

      const reality: HarnessRealitySnapshot = { agentAvailable: true };
      if (run.state.stage !== "COMMIT") return reality;

      const completed = (await listDesktopJobs(input.jobRoot)).find((job) =>
        job.runId === run.request.runId
        && job.stage === "COMMIT"
        && job.status === "completed"
        && job.result?.status === "completed"
        && connected.some((agent) => agent.agentId === job.pack.agentId),
      );
      if (completed?.result) {
        const reference = completed.result.operations.find((item) => item.reference)?.reference;
        if (reference) {
          reality.currentCommit = reference;
          reality.desktopCommit = { key: completed.idempotencyKey, reference, jobId: completed.jobId };
          return reality;
        }
      }

      const jobs = (await listRecoverableDesktopJobs(input.jobRoot, at))
        .filter((job) => job.runId === run.request.runId && job.stage === "COMMIT");
      const job = jobs.find((item) => connected.some((agent) => agent.agentId === item.pack.agentId));
      if (!job) return reality;
      const operation = commitOperation(job.pack);
      if (!operation?.expectedHead) return reality;
      const sessionId = input.transport.getAgentSessionId(job.pack.agentId);
      if (!sessionId) return reality;
      const inspectPack: DesktopTaskPack = {
        version: 1,
        jobId: `inspect-${job.jobId}`,
        runId: run.request.runId,
        stage: "COMMIT",
        attempt: 1,
        agentId: job.pack.agentId,
        workspaceRoot: job.pack.workspaceRoot,
        idempotencyKey: `inspect:${job.idempotencyKey}`,
        leaseUntil: new Date(Date.parse(at) + inspectTimeoutMs).toISOString(),
        operations: [{ id: "inspect", type: "GIT_INSPECT", cwd: operation.cwd, ...(operation.publish ? { includeRemote: true } : {}) }],
      };
      input.transport.sendTask(job.pack.agentId, inspectPack);
      const inspectResult = await input.transport.awaitResult(inspectPack.jobId, inspectTimeoutMs);
      const identity = parseIdentity(inspectResult);
      if (!identity) return reality;
      reality.currentBranch = identity.branch;
      reality.currentCommit = identity.head;
      if (!matchingRecoveredCommit(operation, identity)) return reality;

      await acquireDesktopJobLease(input.jobRoot, job.jobId, sessionId, at, leaseDurationMs);
      const reconciledResult: DesktopJobResult = {
        version: 1,
        jobId: job.jobId,
        runId: job.runId,
        agentId: job.pack.agentId,
        status: "completed",
        completedAt: at,
        operations: [{
          operationId: operation.id,
          ok: true,
          summary: "Recovered existing Git commit",
          reference: identity.head,
        }],
      };
      await completeDesktopJob(input.jobRoot, job.jobId, sessionId, reconciledResult);
      reality.desktopCommit = {
        key: job.idempotencyKey,
        reference: identity.head,
        jobId: job.jobId,
      };
      return reality;
    },
  };
}
