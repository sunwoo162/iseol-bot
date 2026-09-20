import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordProgressAdapter } from "../src/discord-project/progress-discord-adapter.js";

test("Discord progress adapter sends allowlisted content without mentions", async () => {
  let payload: unknown;
  const adapter = createDiscordProgressAdapter({} as never, async () => ({
    send: async (value: unknown) => { payload = value; return { id: "message-1" }; },
  } as never));
  const result = await adapter.send({ eventId: "event-1", projectId: "project-1", title: "run.updated", content: "Project project-1: done", occurredAt: "2026-09-20T00:00:00.000Z" });
  assert.deepEqual(result, { accepted: true, messageId: "message-1" });
  assert.deepEqual(payload, { content: "Project project-1: done", allowedMentions: { parse: [] } });
});

test("Discord progress adapter fails closed when no channel is resolved", async () => {
  const adapter = createDiscordProgressAdapter({} as never, async () => null);
  assert.deepEqual(await adapter.send({ eventId: "event-2", projectId: "project-1", title: "run.updated", content: "bounded", occurredAt: "2026-09-20T00:00:00.000Z" }), { accepted: false });
});
