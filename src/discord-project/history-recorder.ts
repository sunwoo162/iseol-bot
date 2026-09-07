import { createHash } from "node:crypto";
import type {
  ProjectHistoryEvent,
  ProjectHistoryEventType,
  ProjectHistorySource,
  ProjectWorkContext,
} from "../project-model/contracts.js";
import { appendProjectHistoryEventOnce } from "../project-model/history-store.js";

export type DiscordProjectHistoryIdentity = {
  projectId: string;
  nodeId: string;
  runId?: string;
  source: ProjectHistorySource;
  action: string;
  reference: string;
};

export function discordProjectHistoryEventId(
  input: DiscordProjectHistoryIdentity,
): string {
  const key = [
    input.projectId,
    input.nodeId,
    input.runId ?? "",
    input.source,
    input.action,
    input.reference,
  ].join("\u001f");
  return `discord-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

export type RecordDiscordProjectHistoryInput = {
  modelRoot: string;
  context: ProjectWorkContext & { nodeId: string };
  eventType: Extract<
    ProjectHistoryEventType,
    "discord-project-bound" | "discord-action-recorded" | "integration-action-recorded" | "review-recorded"
  >;
  source: ProjectHistorySource;
  action: string;
  reference: string;
  summary: string;
  at: string;
};

export type RecordDiscordProjectHistoryDependencies = {
  appendOnce?: (root: string, event: ProjectHistoryEvent) => Promise<boolean>;
};

function assertSafeSummary(summary: string): void {
  if (!summary.trim()) throw new Error("Project history summary is required");
  if (/authorization\s*:|bearer\s+|(?:token|secret|password)\s*=/i.test(summary)) {
    throw new Error("Project history summary contains credential-like secret material");
  }
}

export async function recordDiscordProjectHistory(
  input: RecordDiscordProjectHistoryInput,
  deps: RecordDiscordProjectHistoryDependencies = {},
): Promise<boolean> {
  assertSafeSummary(input.summary);
  const identity: DiscordProjectHistoryIdentity = {
    projectId: input.context.projectId,
    nodeId: input.context.nodeId,
    ...(input.context.runId === undefined ? {} : { runId: input.context.runId }),
    source: input.source,
    action: input.action,
    reference: input.reference,
  };
  const event: ProjectHistoryEvent = {
    version: 1,
    id: discordProjectHistoryEventId(identity),
    projectId: input.context.projectId,
    type: input.eventType,
    at: input.at,
    summary: input.summary,
    nodeId: input.context.nodeId,
    ...(input.context.runId === undefined ? {} : { runId: input.context.runId }),
    source: input.source,
    action: input.action,
    reference: input.reference,
  };
  return (deps.appendOnce ?? appendProjectHistoryEventOnce)(input.modelRoot, event);
}
