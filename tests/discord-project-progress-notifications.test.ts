import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverProgressNotification, dispatchProgressNotification, formatProgressNotification } from "../src/discord-project/progress-notifications.js";
import { withDurableDiscordProgressNotificationLock } from "../src/discord-project/progress-notification-lock.js";

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

test("concurrent dispatches serialize on the durable event lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-discord-concurrent-"));
  const notification = formatProgressNotification({ id: "evt-concurrent", type: "run.updated", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "done" })!;
  let sends = 0;
  const adapter = { send: async () => { sends += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { accepted: true }; } };
  const results = await Promise.all([dispatchProgressNotification(root, notification, adapter), dispatchProgressNotification(root, notification, adapter)]);
  assert.equal(sends, 1);
  assert.equal(results.filter((result) => result.status === "accepted").length, 1);
  assert.equal(results.filter((result) => result.status === "unknown").length, 1);
});

test("direct progress delivery waits for the durable event lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-discord-concurrent-"));
  const notification = formatProgressNotification({ id: "evt-direct", type: "run.updated", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "done" })!;
  let acquired!: () => void;
  let release!: () => void;
  const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const lockReleased = new Promise<void>((resolve) => { release = resolve; });
  const holder = withDurableDiscordProgressNotificationLock(root, notification.projectId!, notification.eventId, async () => {
    acquired();
    await lockReleased;
  });
  await lockAcquired;

  let completed = false;
  const delivering = deliverProgressNotification(root, notification).finally(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(completed, false);

  release();
  assert.equal(await delivering, true);
  await holder;
});

test("different progress events share the project journal lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-discord-project-journal-lock-"));
  const first = formatProgressNotification({ id: "evt-project-lock-a", type: "run.updated", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "first" })!;
  const second = formatProgressNotification({ id: "evt-project-lock-b", type: "run.updated", occurredAt: "2026-09-20T00:00:01.000Z", projectId: "project-1", summary: "second" })!;
  let acquired!: () => void;
  let release!: () => void;
  const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
  const lockReleased = new Promise<void>((resolve) => { release = resolve; });
  const holder = withDurableDiscordProgressNotificationLock(root, first.projectId!, first.eventId, async () => {
    acquired();
    await lockReleased;
  });
  await lockAcquired;

  let completed = false;
  const delivering = deliverProgressNotification(root, second).finally(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(completed, false);

  release();
  assert.equal(await delivering, true);
  await holder;
});

test("direct delivery and adapter dispatch share one event lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-discord-concurrent-"));
  const notification = formatProgressNotification({ id: "evt-shared", type: "run.updated", occurredAt: "2026-09-20T00:00:00.000Z", projectId: "project-1", summary: "done" })!;
  let sendStarted!: () => void;
  let releaseSend!: () => void;
  const started = new Promise<void>((resolve) => { sendStarted = resolve; });
  const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
  const dispatching = dispatchProgressNotification(root, notification, {
    send: async () => {
      sendStarted();
      await sendReleased;
      return { accepted: true, messageId: "message-shared" };
    },
  });
  await started;

  let completed = false;
  const delivering = deliverProgressNotification(root, notification).finally(() => { completed = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(completed, false);

  releaseSend();
  assert.equal((await dispatching).status, "accepted");
  assert.equal(await delivering, false);
  const file = await readFile(join(root, "discord-notifications", "project-1", "delivered.jsonl"), "utf8");
  assert.equal(file.trim().split(/\r?\n/).length, 1);
});
