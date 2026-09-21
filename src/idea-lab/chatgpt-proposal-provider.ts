import { createHash } from "node:crypto";
import { ChatGptWebSessionLostError } from "../chatgpt-web/browser-adapter.js";
import type { ChatGptBrowserDriver } from "../chatgpt-web/production-browser-adapter.js";
import {
  ExternalRequestBudgetExhaustedError,
  ExternalRequestOutcomeUnknownError,
  type RequestBudgetStore,
} from "../chatgpt-web/request-budget.js";
import {
  assertIdeaProposalProviderResult,
  type IdeaProposalProvider,
  type IdeaProposalProviderInput,
} from "./proposal-provider.js";

const DRAFT_FIELDS = [
  "title", "concept", "problemDomain", "targetUser", "jobToBeDone",
  "coreInteractionLoop", "dataModel", "primaryDifferentiator", "whyMateriallyDifferent",
] as const;
const MAX_CONTEXT_BYTES = 128 * 1024;

function compilePrompt(input: IdeaProposalProviderInput): { body: string; sha256: string } {
  if (!Number.isInteger(input.requestedCount) || input.requestedCount <= 0) {
    throw new Error("Idea proposal requestedCount must be a positive integer");
  }
  const context = {
    seed: input.seed,
    constraints: input.constraints,
    requestedCount: input.requestedCount,
    attempt: input.attempt,
    accepted: input.accepted,
  };
  const contextJson = JSON.stringify(context);
  if (Buffer.byteLength(contextJson, "utf8") > MAX_CONTEXT_BYTES) {
    throw new Error("Idea proposal context exceeds 128 KiB");
  }  const body = [
    "You are the Iseol Idea Lab proposal generator.",
    `Return exactly ${input.requestedCount} materially different proposal(s) as one JSON array and nothing else.`,
    `Each object must contain exactly these string fields: ${DRAFT_FIELDS.join(", ")}.`,
    "Do not add markdown, commentary, metadata, or unknown fields.",
    "New proposals must be materially different from every accepted proposal in problem, user, interaction loop, or data model.",
    `Input context: ${contextJson}`,
  ].join("\n");
  return { body, sha256: createHash("sha256").update(body, "utf8").digest("hex") };
}

export function createChatGptIdeaProposalProvider(
  driver: ChatGptBrowserDriver,
  options: { timeoutMs?: number; requestBudget?: RequestBudgetStore } = {},
): IdeaProposalProvider {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    async generate(input) {
      const prompt = compilePrompt(input);
      let conversationRef: string | undefined;
      let primaryError: unknown;
      const budgetIdentity = input.budgetIdentity;
      const requestId = budgetIdentity ? `proposal-${prompt.sha256.slice(0, 48)}-${input.attempt}` : undefined;
      let budgetReserved = false;
      let submitAttempted = false;
      let responseReceived = false;
      try {
        if (options.requestBudget && budgetIdentity && requestId) {
          const reservation = await options.requestBudget.reserve(budgetIdentity, requestId, { stage: "IDEA_PROPOSAL" });
          if (reservation !== "reserved") throw new ExternalRequestBudgetExhaustedError();
          budgetReserved = true;
        }
        const opened = await driver.openOrResumeConversation({
          prompt: prompt.body,
          promptSha256: prompt.sha256,
        });
        conversationRef = opened.conversationRef;
        submitAttempted = true;
        const submitted = await driver.submitPrompt({
          ...(conversationRef ? { conversationRef } : {}),
          prompt: prompt.body,          promptSha256: prompt.sha256,
        });
        conversationRef = submitted?.conversationRef ?? conversationRef;
        if (!conversationRef) {
          throw new ChatGptWebSessionLostError("Idea proposal conversation reference is unavailable after submit");
        }
        const result = await driver.readStructuredResult({ conversationRef, timeoutMs, contract: "structured-json" });
        responseReceived = true;
        assertIdeaProposalProviderResult(result, input.requestedCount);
        if (options.requestBudget && budgetIdentity && requestId && budgetReserved) {
          await options.requestBudget.complete(budgetIdentity, requestId, "consumed");
          budgetReserved = false;
        }
        return result.map((item) => ({ ...item }));
      } catch (error) {
        primaryError = error;
        if (options.requestBudget && budgetIdentity && requestId && budgetReserved) {
          if (submitAttempted && !responseReceived) {
            await options.requestBudget.complete(budgetIdentity, requestId, "unknown");
            budgetReserved = false;
            if (!(error instanceof ExternalRequestBudgetExhaustedError)) {
              throw new ExternalRequestOutcomeUnknownError();
            }
          } else if (submitAttempted) {
            await options.requestBudget.complete(budgetIdentity, requestId, "consumed");
            budgetReserved = false;
          } else {
            await options.requestBudget.release(budgetIdentity, requestId);
            budgetReserved = false;
          }
        }
        throw error;
      } finally {
        if (conversationRef) {
          try {
            await driver.closeConversation(conversationRef);
          } catch (closeError) {
            if (primaryError === undefined) throw closeError;
          }
        }
      }
    },
  };
}
