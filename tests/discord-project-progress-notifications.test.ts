import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverProgressNotification, formatProgressNotification } from "../src/discord-project/progress-notifications.js";

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
