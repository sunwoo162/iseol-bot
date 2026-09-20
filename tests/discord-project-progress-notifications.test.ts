import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverProgressNotification, dispatchProgressNotification, formatProgressNotification } from "../src/discord-project/progress-notifications.js";

test("progress notifications are bounded and redact credential-like text", () => {
  const notification = formatProgressNotification({ id: "evt-1", type: "run.updated", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "token=secret-value completed" });
  assert.ok(notification);
  assert.match(notification.content, /\[redacted\]/);
  assert.equal(notification.content.includes("secret-value"), false);
});

test("progress notification delivery is durable and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-discord-progress-"));
  const notification = formatProgressNotification({ id: "evt-1", type: "project.updated", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "Purpose selected" })!;
  assert.equal(await deliverProgressNotification(root, notification), true);
  assert.equal(await deliverProgressNotification(root, notification), false);
  const file = await readFile(join(root, "discord-notifications", "project-1", "delivered.jsonl"), "utf8");
  assert.equal(file.trim().split(/\r?\n/).length, 1);
});

test("Discord adapter acceptance is distinct from failed and unknown delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-discord-dispatch-"));
  const notification = formatProgressNotification({ id: "evt-dispatch", type: "run.updated", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "completed" })!;
  let sends = 0;
  const accepted = await dispatchProgressNotification(root, notification, { send: async () => { sends += 1; return { accepted: true, messageId: "message-1" }; } });
  assert.equal(accepted.status, "accepted");
  const duplicate = await dispatchProgressNotification(root, notification, { send: async () => { sends += 1; return { accepted: true }; } });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(sends, 1);

  const failedNotification = formatProgressNotification({ id: "evt-failed", type: "run.failed", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "failed" })!;
  const failed = await dispatchProgressNotification(root, failedNotification, { send: async () => ({ accepted: false }) });
  assert.equal(failed.status, "failed");
  const unknownNotification = formatProgressNotification({ id: "evt-unknown", type: "run.waiting", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "waiting" })!;
  const unknown = await dispatchProgressNotification(root, unknownNotification, { send: async () => { throw new Error("timeout"); } });
  assert.equal(unknown.status, "unknown");
  const preservedUnknown = await dispatchProgressNotification(root, unknownNotification, { send: async () => ({ accepted: true }) });
  assert.equal(preservedUnknown.status, "unknown");
});
