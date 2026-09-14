import { createHash } from "node:crypto";
import type { HarnessEvidenceKind, HarnessRuntimeRunEnvelope } from "../harness/contracts.js";
import type { ReasoningTurn, WebWorkerSession } from "./contracts.js";

export type WebPromptKind = "initial" | "feedback" | "recovery";
export type WebPromptEvidence = {
  kind: HarnessEvidenceKind | string;
  summary: string;
  reference?: string;
};
export type CompileWebPromptInput = {
  kind: WebPromptKind;
  run: HarnessRuntimeRunEnvelope;
  session: WebWorkerSession;
  priorTurns: ReasoningTurn[];
  desktopEvidence?: WebPromptEvidence[];
};
export type CompiledWebPrompt = {
  version: 1;
  kind: WebPromptKind;
  runId: string;
  stage: HarnessRuntimeRunEnvelope["state"]["stage"];
  generation: number;
  policySha256: string;
  body: string;
  sha256: string;
};
const ALLOWED_INTENTS = [
  "READ_CONTEXT", "PROPOSE_PATCH", "RUN_TEST", "RUN_BUILD",
  "GIT_INSPECT", "REQUEST_COMMIT", "CHECK_HTTP",
] as const;

const COMPLETION_TARGETS: Partial<Record<HarnessRuntimeRunEnvelope["state"]["stage"], string>> = {
  ANALYZE: "Complete analysis with decisions and no unresolved reasoning gap.",
  PLAN: "Complete a bounded implementation plan with executable next actions.",
  IMPLEMENT: "Complete the requested implementation through validated Desktop intents and verified feedback.",
  SELF_REVIEW: "Complete self-review with material issues resolved or explicitly blocked.",
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function redact(value: string): string {
  return value
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Za-z0-9_]*(?:TOKEN|COOKIE|SECRET|PASSWORD|API_KEY)[A-Za-z0-9_]*)\s*[:=]\s*([^\s,;]+)/gi, "$1=[REDACTED]");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}
export function compileWebPrompt(input: CompileWebPromptInput): CompiledWebPrompt {
  const policy = input.run.preflight.policy;
  if (input.run.preflight.status !== "ready" || !policy) throw new Error("ChatGPT Web prompt requires ready Harness policy");
  if (input.session.runId !== input.run.request.runId) throw new Error("ChatGPT Web session runId mismatch");
  if (input.session.stage !== input.run.state.stage) throw new Error("ChatGPT Web session stage mismatch");
  if (input.session.policySha256 !== policy.effectiveSha256) throw new Error("ChatGPT Web session policy mismatch");

  const priorDecisions = input.priorTurns.flatMap((turn) => turn.decisions.map(redact));
  const evidence = (input.desktopEvidence ?? []).map((item) => ({
    kind: item.kind,
    summary: redact(item.summary),
    ...(item.reference === undefined ? {} : { reference: redact(item.reference) }),
  }));
  const payload = {
    protocolVersion: 1,
    promptKind: input.kind,
    run: { id: input.run.request.runId, objective: redact(input.run.request.objective), stage: input.run.state.stage },
    worker: { generation: input.session.generation },
    policy: {
      effectiveSha256: policy.effectiveSha256,
      sources: policy.sources.map((source) => ({ kind: source.kind, path: source.path, sha256: source.sha256 })),
    },
    completion: COMPLETION_TARGETS[input.run.state.stage] ?? `Complete ${input.run.state.stage} according to Harness evidence requirements.`,
    allowedDesktopIntents: ALLOWED_INTENTS,
    priorDecisions,
    desktopEvidence: evidence,
    recovery: input.kind === "recovery" ? "Resume from the first unfinished verified step; do not repeat verified side effects." : null,
    outputContract: {
      responseFormat: "exactly-one-json-object-no-markdown-or-prose",
      reasoningTurnResult: {
        version: 1,
        runId: input.run.request.runId,
        stage: input.run.state.stage,
        generation: input.session.generation,
        summary: "non-empty string",
        decisions: ["string"],
        intents: [],
        outcome: "continue|stage-complete|blocked-user|retryable",
      },
      desktopIntentCommonRequired: {
        version: 1,
        intentId: "unique non-empty id",
        runId: input.run.request.runId,
        stage: input.run.state.stage,
        workspaceRoot: input.run.request.targetRoot,
        policySha256: policy.effectiveSha256,
      },
      requiredFieldsByIntentKind: {
        READ_CONTEXT: ["path"],
        PROPOSE_PATCH: ["path", "patch"],
        RUN_TEST: ["cwd", "executable", "args", "timeoutMs"],
        RUN_BUILD: ["cwd", "executable", "args", "timeoutMs"],
        GIT_INSPECT: ["cwd"],
        REQUEST_COMMIT: ["cwd", "message", "expectedHead?"],
        CHECK_HTTP: ["url", "timeoutMs"],
      },
      blockerReasonRule: "Include blockerReason only when outcome is blocked-user; otherwise omit it.",
    },
  };
  const body = JSON.stringify(stable(payload), null, 2);
  return {
    version: 1,
    kind: input.kind,
    runId: input.run.request.runId,
    stage: input.run.state.stage,
    generation: input.session.generation,
    policySha256: policy.effectiveSha256,
    body,
    sha256: sha256(body),
  };
}
