import { createHash } from "node:crypto";
import type { HarnessEvidenceRecord, HarnessRuntimeRunEnvelope } from "../harness/contracts.js";
import type { HarnessStageExecutor, HarnessStageExecutionResult } from "../harness/run-supervisor.js";
import type { DesktopIntent, ReasoningTurn, WebWorkerSession } from "./contracts.js";
import { assertReasoningTurnResult } from "./contracts.js";
import type { ChatGptWebBrowserAdapter } from "./browser-adapter.js";
import { ChatGptWebSessionLostError, ChatGptWebStructuredResultError } from "./browser-adapter.js";
import { compileWebPrompt, type CompiledWebPrompt, type WebPromptEvidence } from "./prompt-compiler.js";
import { createWebWorkerSession, getActiveWebWorkerSession, getPointedWebWorkerSession, replaceLostWebWorkerSession, updateWebWorkerSession } from "./session-store.js";
import { appendReasoningTurn, listReasoningTurns } from "./turn-store.js";
import { recordDesktopIntent } from "./intent-store.js";
import { validateDesktopIntent } from "./intent-compiler.js";
import { assertActiveWebWorkerResult, recoverWebWorkerSession } from "./recovery.js";

export type WebDesktopIntentRunnerInput = {
  run: HarnessRuntimeRunEnvelope;
  session: WebWorkerSession;
  intent: DesktopIntent;
};
export type WebDesktopIntentExecutionResult =
  | { type: "completed"; evidence: HarnessEvidenceRecord[]; feedback?: WebPromptEvidence[] }
  | Exclude<HarnessStageExecutionResult, { type: "completed" }>;
export type WebDesktopIntentRunner = (input: WebDesktopIntentRunnerInput) => Promise<WebDesktopIntentExecutionResult>;

export type CreateWebReasoningExecutorInput = {
  workerRoot: string;
  adapter: ChatGptWebBrowserAdapter;
  runDesktopIntent: WebDesktopIntentRunner;
  recoverDesktopFeedback?: (input: { run: HarnessRuntimeRunEnvelope; priorTurns: ReasoningTurn[] }) => Promise<WebPromptEvidence[]>;
  now?: () => string;
  resultTimeoutMs?: number;
  maxTurnsPerStage?: number;
  maxRejectedIntents?: number;
  commitAuthorized?: boolean;
};
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function sessionId(runId: string, stage: string, generation: number): string {
  return `web-${digest(`${runId}\n${stage}\n${generation}`).slice(0, 24)}`;
}
function turnId(session: WebWorkerSession, prompt: CompiledWebPrompt, responseSha256: string): string {
  return `turn-${digest(`${session.sessionId}\n${prompt.sha256}\n${responseSha256}`).slice(0, 24)}`;
}
function reasoningEvidence(turn: ReasoningTurn): HarnessEvidenceRecord {
  return {
    version: 1,
    id: `web-${turn.turnId}`,
    kind: turn.stage === "SELF_REVIEW" ? "review" : "command",
    stage: turn.stage,
    recordedAt: turn.recordedAt,
    summary: turn.summary,
    provider: "chatgpt-web",
    reference: `reasoning-turn:${turn.turnId}`,
  };
}
function feedbackEvidence(records: HarnessEvidenceRecord[]): WebPromptEvidence[] {
  return records.map((item) => ({ kind: item.kind, summary: item.summary, ...(item.reference ? { reference: item.reference } : {}) }));
}
const STRUCTURED_JSON_CORRECTION = "Previous response was not valid structured output. Return no markdown or prose. Without PROPOSE_PATCH, return exactly one JSON object. With PROPOSE_PATCH, use a single-line JSON header where patch is @@ISEOL_PATCH:<intentId>@@, then emit the raw git apply-compatible unified diff between @@ISEOL_PATCH_BEGIN:<intentId>@@ and @@ISEOL_PATCH_END:<intentId>@@. Each begin/end marker must be a standalone line with a newline immediately before and after it (EOF allowed after the final end marker). Each appendix must contain exactly one file diff; every hunk body line needs a unified-diff prefix (space, +, -, or \\), blank added lines are +, and hunk counts must match. Never use *** Begin Patch markers.";
function structuredCorrection(reason: string): string {
  const boundedReason = reason.replace(/\s+/g, " ").trim().slice(0, 240);
  return `${STRUCTURED_JSON_CORRECTION} Validation failure: ${boundedReason}`;
}
async function ensureSession(input: CreateWebReasoningExecutorInput, run: HarnessRuntimeRunEnvelope, at: string): Promise<WebWorkerSession> {
  const existing = await getActiveWebWorkerSession(input.workerRoot, run.request.runId, run.state.stage);
  if (existing) return existing;
  const policy = run.preflight.policy;
  if (run.preflight.status !== "ready" || !policy) throw new Error("Web reasoning requires ready Harness policy");
  const pointed = await getPointedWebWorkerSession(input.workerRoot, run.request.runId, run.state.stage);
  if (pointed?.status === "lost") {
    const generation = pointed.generation + 1;
    return replaceLostWebWorkerSession(input.workerRoot, pointed.sessionId, {
      version: 1,
      sessionId: sessionId(run.request.runId, run.state.stage, generation),
      runId: run.request.runId,
      stage: run.state.stage,
      generation,
      policySha256: policy.effectiveSha256,
      status: "ready",
      createdAt: at,
    }, at);
  }
  return createWebWorkerSession(input.workerRoot, {
    version: 1,
    sessionId: sessionId(run.request.runId, run.state.stage, 1),
    runId: run.request.runId,
    stage: run.state.stage,
    generation: 1,
    policySha256: policy.effectiveSha256,
    status: "ready",
    createdAt: at,
  });
}
export function createWebReasoningExecutor(input: CreateWebReasoningExecutorInput): HarnessStageExecutor {
  const now = input.now ?? (() => new Date().toISOString());
  const resultTimeoutMs = input.resultTimeoutMs ?? 240_000;
  const maxTurns = input.maxTurnsPerStage ?? 8;
  const maxRejected = input.maxRejectedIntents ?? 3;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) throw new Error("maxTurnsPerStage must be a positive integer");
  if (!Number.isInteger(maxRejected) || maxRejected <= 0) throw new Error("maxRejectedIntents must be a positive integer");

  return {
    async execute(run): Promise<HarnessStageExecutionResult> {
      if (!["ANALYZE", "PLAN", "IMPLEMENT", "SELF_REVIEW"].includes(run.state.stage)) {
        return { type: "waiting-external", reason: `${run.state.stage} is not owned by ChatGPT Web reasoning` };
      }
      let session = await ensureSession(input, run, now());
      let priorTurns = (await listReasoningTurns(input.workerRoot, run.request.runId))
        .filter((turn) => turn.stage === run.state.stage);
      const accumulatedEvidence: HarnessEvidenceRecord[] = [];
      let desktopEvidence: WebPromptEvidence[] = priorTurns.length > 0 && input.recoverDesktopFeedback
        ? await input.recoverDesktopFeedback({ run, priorTurns })
        : [];
      let prompt = compileWebPrompt({
        kind: priorTurns.length === 0 ? "initial" : "feedback",
        run, session, priorTurns, desktopEvidence,
      });
      let openedSessionId: string | null = null;
      let acceptedTurns = 0;
      let rejectedCount = 0;
      let recoveries = 0;

      while (acceptedTurns < maxTurns) {
        let rawResult: unknown;
        try {
          if (openedSessionId !== session.sessionId) {
            const opened = await input.adapter.openOrResumeSession(session, prompt);
            if (opened.conversationRef && opened.conversationRef !== session.conversationRef) {
              session = await updateWebWorkerSession(input.workerRoot, { ...session, conversationRef: opened.conversationRef });
            }
            openedSessionId = session.sessionId;
          }
          const submitted = await input.adapter.submitTurn(session, prompt);
          if (submitted?.conversationRef && submitted.conversationRef !== session.conversationRef) {
            session = await updateWebWorkerSession(input.workerRoot, { ...session, conversationRef: submitted.conversationRef });
          }
          rawResult = await input.adapter.awaitStructuredResult(session, resultTimeoutMs);
        } catch (error) {
          if (error instanceof ChatGptWebStructuredResultError) {
            rejectedCount += 1;
            if (rejectedCount >= maxRejected) {
              return { type: "retryable-failure", reason: `Rejected reasoning result budget exhausted: ${error.message}` };
            }
            desktopEvidence = [...desktopEvidence, { kind: "reasoning-rejection", summary: structuredCorrection(error.message) }];
            prompt = compileWebPrompt({ kind: "feedback", run, session, priorTurns, desktopEvidence });
            continue;
          }
          if (!(error instanceof ChatGptWebSessionLostError)) {
            return { type: "retryable-failure", reason: error instanceof Error ? error.message : String(error) };
          }
          recoveries += 1;
          if (recoveries > maxTurns) return { type: "retryable-failure", reason: "ChatGPT Web session recovery budget exhausted" };
          const recovered = await recoverWebWorkerSession({
            workerRoot: input.workerRoot, run, session, priorTurns, desktopEvidence, at: now(),
          });
          session = recovered.session;
          prompt = recovered.prompt;
          openedSessionId = null;
          continue;
        }

        let result;
        try {
          assertReasoningTurnResult(rawResult);
          result = await assertActiveWebWorkerResult(input.workerRoot, run, session, rawResult);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (/result generation is stale/i.test(reason)) {
            rejectedCount += 1;
            if (rejectedCount >= maxRejected) return { type: "retryable-failure", reason: `Rejected reasoning result budget exhausted: ${reason}` };
            const receivedGeneration = (rawResult as { generation?: unknown }).generation;
            desktopEvidence = [...desktopEvidence, {
              kind: "reasoning-rejection",
              summary: `Expected generation ${session.generation}; received ${String(receivedGeneration)}. ${reason}`,
            }];
            prompt = compileWebPrompt({ kind: "feedback", run, session, priorTurns, desktopEvidence });
            continue;
          }
          if (/policy|stale|generation|active session/i.test(reason)) return { type: "retryable-failure", reason };
          rejectedCount += 1;
          if (rejectedCount >= maxRejected) return { type: "retryable-failure", reason: `Rejected reasoning result budget exhausted: ${reason}` };
          desktopEvidence = [...desktopEvidence, { kind: "reasoning-rejection", summary: reason }];
          prompt = compileWebPrompt({ kind: "feedback", run, session, priorTurns, desktopEvidence });
          continue;
        }
        const turnDesktopFeedback: WebPromptEvidence[] = [];
        const rejectedFeedback: WebPromptEvidence[] = [];
        for (const intent of result.intents) {
          try {
            validateDesktopIntent({
              run,
              session,
              resultGeneration: result.generation,
              commitAuthorized: input.commitAuthorized ?? false,
            }, intent);
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await recordDesktopIntent(input.workerRoot, { intent, status: "rejected", reason, recordedAt: now() });
            rejectedCount += 1;
            rejectedFeedback.push({ kind: "reasoning-rejection", summary: reason, reference: `intent:${intent.intentId}` });
            if (rejectedCount >= maxRejected) {
              return { type: "retryable-failure", reason: `Rejected intent budget exhausted: ${reason}` };
            }
            continue;
          }

          await recordDesktopIntent(input.workerRoot, { intent, status: "accepted", recordedAt: now() });
          let desktopResult: WebDesktopIntentExecutionResult;
          try {
            desktopResult = await input.runDesktopIntent({ run, session, intent });
          } catch (error) {
            return { type: "retryable-failure", reason: error instanceof Error ? error.message : String(error) };
          }
          if (desktopResult.type !== "completed") return desktopResult;
          accumulatedEvidence.push(...desktopResult.evidence);
          turnDesktopFeedback.push(...(desktopResult.feedback ?? feedbackEvidence(desktopResult.evidence)));
        }

        const responseSha256 = digest(JSON.stringify(result));
        const turn: ReasoningTurn = {
          version: 1,
          turnId: turnId(session, prompt, responseSha256),
          sessionId: session.sessionId,
          runId: run.request.runId,
          stage: run.state.stage,
          generation: session.generation,
          promptSha256: prompt.sha256,
          responseSha256,
          summary: result.summary,
          decisions: [...result.decisions],
          desktopIntentIds: result.intents.map((intent) => intent.intentId),
          outcome: result.outcome,
          recordedAt: now(),
        };
        await appendReasoningTurn(input.workerRoot, turn);
        priorTurns = [...priorTurns, turn];
        session = await updateWebWorkerSession(input.workerRoot, { ...session, lastTurnAt: turn.recordedAt, status: "ready" });
        acceptedTurns += 1;

        if (result.outcome === "blocked-user") return { type: "blocked-user", reason: result.blockerReason! };
        if (result.outcome === "retryable") return { type: "retryable-failure", reason: result.summary };
        if (result.outcome === "stage-complete") {
          return { type: "completed", evidence: [...accumulatedEvidence, reasoningEvidence(turn)] };
        }

        desktopEvidence = [
          ...desktopEvidence,
          ...turnDesktopFeedback,
          ...rejectedFeedback,
        ];
        prompt = compileWebPrompt({ kind: "feedback", run, session, priorTurns, desktopEvidence });
      }

      return { type: "retryable-failure", reason: `ChatGPT Web turn budget exhausted after ${maxTurns} turns` };
    },
  };
}
