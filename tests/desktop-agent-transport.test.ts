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
  await transport.handleMessage("session-1", { version: 1, type: "result", result: result() });
  assert.deepEqual(await waiting, result());
  await assert.rejects(
    transport.handleMessage("session-1", { version: 1, type: "result", result: result("job-unknown") }),
    /unknown desktop job result/i,
  );
  transport.disconnect("session-1");
  assert.equal(transport.isAgentConnected("agent-001"), false);
});

test("duplicate dispatch joins the existing pending logical job", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({ registryRoot, expectedToken: "secret-token" });
  const wire = new FakeWire();
  await transport.acceptHello("session-1", hello, wire);
  transport.sendTask("agent-001", task("job-join"));
  assert.doesNotThrow(() => transport.sendTask("agent-001", task("job-join")));
  const first = transport.awaitResult("job-join", 1_000);
  const second = transport.awaitResult("job-join", 1_000);
  await transport.handleMessage("session-1", { version: 1, type: "result", result: result("job-join") });
  assert.equal((await first).jobId, "job-join");
  assert.equal((await second).jobId, "job-join");
  assert.equal(wire.messages.length, 1);
});

test("higher read-only retry attempt redispatches a pending logical job", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({
    registryRoot,
    expectedToken: "secret-token",
  });
  const wire = new FakeWire();

  await transport.acceptHello("session-1", hello, wire);

  const first = task("job-retry");
  transport.sendTask("agent-001", first);

  transport.sendTask("agent-001", {
    ...first,
    attempt: first.attempt + 1,
  });

  assert.equal(wire.messages.length, 2);

  const waiting = transport.awaitResult("job-retry", 1_000);
  await transport.handleMessage("session-1", {
    version: 1,
    type: "result",
    result: result("job-retry"),
  });

  assert.equal((await waiting).jobId, "job-retry");
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

test("late result after await timeout remains recoverable", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({ registryRoot, expectedToken: "secret-token" });
  const wire = new FakeWire();
  await transport.acceptHello("session-late", hello, wire);
  transport.sendTask("agent-001", task("job-late"));

  await assert.rejects(transport.awaitResult("job-late", 1), /result timeout/i);
  await transport.handleMessage("session-late", { version: 1, type: "result", result: result("job-late") });
  assert.equal((await transport.awaitResult("job-late", 1_000)).jobId, "job-late");
  await transport.handleMessage("session-late", { version: 1, type: "result", result: result("job-late") });
  await assert.rejects(
    transport.handleMessage("session-late", { version: 1, type: "result", result: { ...result("job-late"), completedAt: "different" } }),
    /immutable|conflict/i,
  );
});

test("completed result is replayed after disconnect before delivery", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({ registryRoot, expectedToken: "secret-token" });
  const server = await startDesktopAgentWebSocketServer({ host: "127.0.0.1", port: 0, transport });
  const completedResults = new Map<string, DesktopJobResult>();
  let first!: Awaited<ReturnType<typeof connectDesktopAgentWebSocketClient>>;
  let taskSeen!: () => void;
  const seen = new Promise<void>((resolve) => { taskSeen = resolve; });
  let release!: () => void;
  const releaseTask = new Promise<void>((resolve) => { release = resolve; });
  try {
    first = await connectDesktopAgentWebSocketClient({
      url: server.url,
      hello,
      heartbeatIntervalMs: 25,
      completedResults,
      onTask: async (pack) => {
        taskSeen();
        await releaseTask;
        return result(pack.jobId);
      },
    } as any);
    transport.sendTask("agent-001", task("job-replay"));
    await seen;
    await first.close();
    release();

    const second = await connectDesktopAgentWebSocketClient({
      url: server.url,
      hello,
      heartbeatIntervalMs: 25,
      completedResults,
      onTask: async (pack) => result(pack.jobId),
    } as any);
    try {
      assert.equal((await transport.awaitResult("job-replay", 1_000)).jobId, "job-replay");
      assert.equal(completedResults.size, 1);
    } finally {
      await second.close();
    }
  } finally {
    if (first) await first.close();
    await server.close();
  }
});

test("transport frames require the supported protocol version", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({ registryRoot, expectedToken: "secret-token" });
  const wire = new FakeWire();
  await transport.acceptHello("session-1", hello, wire);

  await assert.rejects(
    transport.handleMessage("session-1", {
      version: 99,
      type: "heartbeat",
      at: "2026-09-08T02:00:00.000Z",
    } as any),
    /unsupported iseol desktop protocol version/i,
  );

  transport.sendTask("agent-001", task("job-versioned"));
  assert.equal((wire.messages[0] as any)?.version, 1);
});

test("accepted Desktop Agent hello notifies connection listeners", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({
    registryRoot,
    expectedToken: "secret-token",
  });

  const connected: string[] = [];

  const unsubscribe = (transport as any).onAgentConnected?.(
    (agentId: string) => {
      connected.push(agentId);
    },
  );

  assert.equal(
    typeof unsubscribe,
    "function",
    "transport must expose an Agent connection subscription",
  );

  await transport.acceptHello(
    "session-listener-1",
    hello,
    new FakeWire(),
  );

  await transport.acceptHello(
    "session-listener-2",
    hello,
    new FakeWire(),
  );

  assert.deepEqual(
    connected,
    ["agent-001", "agent-001"],
    "initial connect and replacement reconnect must both emit",
  );

  unsubscribe();
});

test("connection listener failure does not reject an accepted Desktop Agent hello", async () => {
  const registryRoot = await root();
  const transport = createDesktopAgentTransport({
    registryRoot,
    expectedToken: "secret-token",
  });

  const observed: string[] = [];

  transport.onAgentConnected(() => {
    throw new Error("listener failed");
  });

  transport.onAgentConnected((agentId) => {
    observed.push(agentId);
  });

  await transport.acceptHello(
    "session-listener-isolation",
    hello,
    new FakeWire(),
  );

  assert.equal(
    transport.isAgentConnected("agent-001"),
    true,
    "accepted hello must remain connected even if one listener fails",
  );

  assert.deepEqual(
    observed,
    ["agent-001"],
    "one failing listener must not prevent later listeners",
  );
});
