import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopAgentHello, DesktopJobResult, DesktopTaskPack } from "../src/desktop-agent/contracts.js";
import {
  createDesktopAgentTransport,
  type DesktopAgentWire,
} from "../src/desktop-agent/transport.js";
import { startDesktopAgentWebSocketServer } from "../src/desktop-agent/ws-server.js";
import { connectDesktopAgentWebSocketClient } from "../src/desktop-agent/ws-client.js";

const hello: DesktopAgentHello = {
  version: 1,
  agentId: "agent-001",
  agentVersion: "0.1.0",
  os: "win32",
  capabilities: ["process", "git"],
  workspaceRoots: ["C:/Users/user/Documents"],
  token: "secret-token",
};

async function root() {
  return mkdtemp(join(tmpdir(), "iseol-desktop-transport-"));
}

function task(jobId = "job-001"): DesktopTaskPack {
  return {
    version: 1,
    jobId,
    runId: "run-001",
    stage: "TEST",
    attempt: 1,
    agentId: "agent-001",
    workspaceRoot: "C:/repo",
    idempotencyKey: `test:${jobId}`,
    leaseUntil: "2026-09-08T03:00:00.000Z",
    operations: [{ id: "op-1", type: "READ_FILE", path: "README.md" }],
  };
}

function result(jobId = "job-001"): DesktopJobResult {
  return {
    version: 1,
    jobId,
    runId: "run-001",
    agentId: "agent-001",
    status: "completed",
    completedAt: "2026-09-08T02:00:00.000Z",
    operations: [{ operationId: "op-1", ok: true, summary: "done" }],
  };
}

class FakeWire implements DesktopAgentWire {
  messages: unknown[] = [];
  closed = false;
  send(message: unknown) { this.messages.push(message); }
  close() { this.closed = true; }
}

test("hello authentication is strict and duplicate live session is replaced", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({ registryRoot, expectedToken: "secret-token" });
  const first = new FakeWire();
  await transport.acceptHello("session-1", hello, first);
  assert.equal(transport.isAgentConnected("agent-001"), true);

  await assert.rejects(
    transport.acceptHello("session-bad", { ...hello, token: "wrong" }, new FakeWire()),
    /authentication failed/i,
  );

  const second = new FakeWire();
  await transport.acceptHello("session-2", hello, second);
  assert.equal(first.closed, true);
  assert.equal(transport.isAgentConnected("agent-001"), true);
});

test("task/result correlation rejects unknown results and disconnect only drops session", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({ registryRoot, expectedToken: "secret-token" });
  const wire = new FakeWire();
  await transport.acceptHello("session-1", hello, wire);
  transport.sendTask("agent-001", task());
  const waiting = transport.awaitResult("job-001", 1_000);
  await transport.handleMessage("session-1", { type: "result", result: result() });
  assert.deepEqual(await waiting, result());
  await assert.rejects(
    transport.handleMessage("session-1", { type: "result", result: result("job-unknown") }),
    /unknown desktop job result/i,
  );
  transport.disconnect("session-1");
  assert.equal(transport.isAgentConnected("agent-001"), false);
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error("condition timeout");
}

test("loopback WebSocket supports outbound connect task result disconnect and reconnect", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({ registryRoot, expectedToken: "secret-token" });
  const server = await startDesktopAgentWebSocketServer({ host: "127.0.0.1", port: 0, transport });
  const onTask = async (pack: DesktopTaskPack) => result(pack.jobId);
  const client = await connectDesktopAgentWebSocketClient({
    url: server.url,
    hello,
    heartbeatIntervalMs: 25,
    onTask,
  });
  try {
    await waitFor(() => transport.isAgentConnected("agent-001"));
    transport.sendTask("agent-001", task("job-live-1"));
    assert.equal((await transport.awaitResult("job-live-1", 1_000)).jobId, "job-live-1");

    await client.close();
    await waitFor(() => !transport.isAgentConnected("agent-001"));
    const second = await connectDesktopAgentWebSocketClient({
      url: server.url,
      hello,
      heartbeatIntervalMs: 25,
      onTask,
    });
    try {
      await waitFor(() => transport.isAgentConnected("agent-001"));
      transport.sendTask("agent-001", task("job-live-2"));
      assert.equal((await transport.awaitResult("job-live-2", 1_000)).jobId, "job-live-2");
    } finally {
      await second.close();
    }
  } finally {
    await server.close();
  }
});
