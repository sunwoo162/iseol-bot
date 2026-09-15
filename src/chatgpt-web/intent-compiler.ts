import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { assertBoundedProcessRequest } from "../desktop-agent/process-policy.js";
import type { HarnessRuntimeRunEnvelope, HarnessRunStage } from "../harness/contracts.js";
import type { DesktopTaskPack, DesktopOperation } from "../desktop-agent/contracts.js";
import { assertDesktopTaskPack } from "../desktop-agent/contracts.js";
import type { DesktopIntent, WebWorkerSession } from "./contracts.js";
import { assertDesktopIntent } from "./contracts.js";

export type DesktopIntentCompilerContext = {
  run: HarnessRuntimeRunEnvelope;
  session: WebWorkerSession;
  resultGeneration: number;
  commitAuthorized?: boolean;
  leaseDurationMs?: number;
};

const REASONING_STAGES = new Set<HarnessRunStage>(["ANALYZE", "PLAN", "IMPLEMENT", "SELF_REVIEW"]);

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function assertRelativeWorkspacePath(root: string, input: string, field: string): void {
  if (isAbsolute(input)) {
    const hint = field === "Desktop intent cwd" ? '; use "." for the workspace root instead of workspaceRoot' : "";
    throw new Error(`${field} must be workspace-relative${hint}`);
  }
  const target = resolve(root, input);
  const rel = relative(resolve(root), target);
  if (rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`${field} is outside the Run workspace`);
  }
}
function assertProcessIntent(intent: Extract<DesktopIntent, { kind: "RUN_TEST" | "RUN_BUILD" }>): void {
  assertBoundedProcessRequest(intent.kind === "RUN_TEST" ? "test" : "build", intent.executable, intent.args);
}

export function validateDesktopIntent(
  context: DesktopIntentCompilerContext,
  intent: DesktopIntent,
): void {
  assertDesktopIntent(intent);
  const { run, session } = context;
  const policy = run.preflight.policy;
  if (run.preflight.status !== "ready" || !policy) throw new Error("Run policy is not ready");
  if (!REASONING_STAGES.has(run.state.stage)) throw new Error(`Stage is not Web-reasoning owned: ${run.state.stage}`);
  if (session.status === "lost" || session.status === "closed") throw new Error("Web worker session is not active");
  if (session.runId !== run.request.runId || intent.runId !== run.request.runId) throw new Error("Desktop intent Run mismatch");
  if (session.stage !== run.state.stage || intent.stage !== run.state.stage) throw new Error("Desktop intent stage mismatch");
  if (context.resultGeneration !== session.generation) throw new Error("Desktop intent generation mismatch");
  if (session.policySha256 !== policy.effectiveSha256 || intent.policySha256 !== policy.effectiveSha256) {
    throw new Error("Desktop intent policy mismatch");
  }
  if (!samePath(intent.workspaceRoot, run.request.targetRoot)) throw new Error("Desktop intent workspace mismatch");

  if (intent.kind === "READ_CONTEXT" || intent.kind === "PROPOSE_PATCH") {
    assertRelativeWorkspacePath(run.request.targetRoot, intent.path, "Desktop intent path");
  }
  if (intent.kind === "RUN_TEST" || intent.kind === "RUN_BUILD") {
    assertRelativeWorkspacePath(run.request.targetRoot, intent.cwd, "Desktop intent cwd");
    assertProcessIntent(intent);
  }
  if (intent.kind === "GIT_INSPECT" || intent.kind === "REQUEST_COMMIT") {
    assertRelativeWorkspacePath(run.request.targetRoot, intent.cwd, "Desktop intent cwd");
  }
  if (intent.kind === "REQUEST_COMMIT" && !context.commitAuthorized) {
    throw new Error("Desktop commit is not explicitly authorized");
  }
}
function operationForIntent(intent: DesktopIntent): DesktopOperation {
  if (intent.kind === "READ_CONTEXT") return { id: intent.intentId, type: "READ_FILE", path: intent.path };
  if (intent.kind === "PROPOSE_PATCH") return { id: intent.intentId, type: "APPLY_PATCH", path: intent.path, patch: intent.patch };
  if (intent.kind === "RUN_TEST" || intent.kind === "RUN_BUILD") {
    return { id: intent.intentId, type: "RUN_PROCESS", purpose: intent.kind === "RUN_TEST" ? "test" : "build", cwd: intent.cwd, executable: intent.executable, args: [...intent.args], timeoutMs: intent.timeoutMs };
  }
  if (intent.kind === "GIT_INSPECT") return { id: intent.intentId, type: "GIT_INSPECT", cwd: intent.cwd };
  if (intent.kind === "REQUEST_COMMIT") {
    return { id: intent.intentId, type: "GIT_COMMIT", cwd: intent.cwd, message: intent.message, ...(intent.expectedHead ? { expectedHead: intent.expectedHead } : {}) };
  }
  if ("url" in intent) return { id: intent.intentId, type: "CHECK_HTTP", url: intent.url, timeoutMs: intent.timeoutMs };
  throw new Error(`Unsupported Desktop intent kind: ${intent.kind}`);
}

function stableJobId(runId: string, intentId: string): string {
  const digest = createHash("sha256").update(`${runId}\n${intentId}`, "utf8").digest("hex").slice(0, 24);
  return `web-${digest}`;
}

export function compileDesktopIntentToTaskPack(
  context: DesktopIntentCompilerContext,
  intent: DesktopIntent,
  agentId: string,
  now: string,
): DesktopTaskPack {
  validateDesktopIntent(context, intent);
  const policy = context.run.preflight.policy!;
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new Error("Desktop Task Pack compile time must be an ISO timestamp");
  const leaseDurationMs = context.leaseDurationMs ?? 60_000;
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) throw new Error("Desktop Task Pack lease duration must be positive");
  const pack: DesktopTaskPack = {
    version: 1,
    jobId: stableJobId(context.run.request.runId, intent.intentId),
    runId: context.run.request.runId,
    stage: context.run.state.stage,
    attempt: 0,
    agentId,
    workspaceRoot: context.run.request.targetRoot,
    policyDigest: policy.effectiveSha256,
    policySources: policy.sources.map((source) => ({ kind: source.kind, path: source.path, sha256: source.sha256, required: true })),
    idempotencyKey: `web-intent:${context.run.request.runId}:${intent.intentId}`,
    leaseUntil: new Date(nowMs + leaseDurationMs).toISOString(),
    operations: [operationForIntent(intent)],
  };
  assertDesktopTaskPack(pack);
  return pack;
}