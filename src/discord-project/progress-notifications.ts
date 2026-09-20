import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertProjectModelId } from "../project-model/contracts.js";

export type ProgressNotificationEvent = {
  id: string;
  type: string;
  occurredAt: string;
  projectId?: string;
  campaignId?: string;
  runId?: string;
  summary?: string;
  status?: string;
};

export type DiscordProgressNotification = {
  eventId: string;
  projectId?: string;
  title: string;
  content: string;
  occurredAt: string;
};

function notificationFile(root: string, projectId: string): string {
  assertProjectModelId(projectId);
  return resolve(root, "discord-notifications", projectId, "delivered.jsonl");
}

function safe(value: string | undefined, max = 240): string {
  if (!value) return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/(?:bearer|token|secret|password)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, max);
}

export function formatProgressNotification(event: ProgressNotificationEvent): DiscordProgressNotification | null {
  const projectId = event.projectId;
  if (!projectId && !event.campaignId) return null;
  const subject = projectId ? `Project ${projectId}` : `Campaign ${event.campaignId}`;
  const status = event.status ? ` · ${safe(event.status, 60)}` : "";
  const summary = safe(event.summary, 220);
  return {
    eventId: event.id,
    ...(projectId ? { projectId } : {}),
    title: `${event.type}${status}`,
    content: `${subject}: ${summary || event.type}`.slice(0, 500),
    occurredAt: event.occurredAt,
  };
}

export async function deliverProgressNotification(root: string, notification: DiscordProgressNotification): Promise<boolean> {
  if (!notification.projectId) return false;
  const path = notificationFile(root, notification.projectId);
  await mkdir(dirname(path), { recursive: true });
  let existing: Array<{ eventId?: string }> = [];
  try {
    existing = (await readFile(path, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { eventId?: string });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing.some((item) => item.eventId === notification.eventId)) return false;
  await appendFile(path, `${JSON.stringify(notification)}\n`, "utf8");
  return true;
}
