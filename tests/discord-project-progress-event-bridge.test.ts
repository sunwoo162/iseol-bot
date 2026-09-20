import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebProductEventBus } from "../src/web-control-plane/event-bus.js";
import { connectProgressEventBridge } from "../src/discord-project/progress-event-bridge.js";

test("Web Product events become one bounded durable Discord delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-progress-bridge-"));
  const bus = new WebProductEventBus();
  let sends = 0;
  const results: string[] = [];
  const disconnect = connectProgressEventBridge({
    eventBus: bus,
    durableRoot: root,
    adapter: { send: async (notification) => { sends += 1; assert.equal(notification.projectId, "project-1"); return { accepted: true, messageId: "message-1" }; } },
    onResult: (_event, result) => results.push(result.status),
  });
  bus.publish({ type: "work-request.updated", scope: { projectId: "project-1" }, payload: { projectId: "project-1", status: "running", blocker: "bounded" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  disconnect();
  assert.equal(sends, 1);
  assert.deepEqual(results, ["accepted"]);
  const content = await readFile(join(root, "discord-notifications", "project-1", "delivered.jsonl"), "utf8");
  assert.match(content, /message-1/);
});

test("bridge disconnect prevents later events from dispatching", async () => {
  const root = await mkdtemp(join(tmpdir(), "iseol-progress-bridge-stop-"));
  const bus = new WebProductEventBus();
  let sends = 0;
  const disconnect = connectProgressEventBridge({ eventBus: bus, durableRoot: root, adapter: { send: async () => { sends += 1; return { accepted: true }; } } });
  disconnect();
  bus.publish({ type: "project.updated", scope: { projectId: "project-1" }, payload: { projectId: "project-1", status: "done" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sends, 0);
});
