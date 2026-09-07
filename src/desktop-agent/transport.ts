import { timingSafeEqual } from "node:crypto";
import type { DesktopAgentHello, DesktopJobResult, DesktopTaskPack } from "./contracts.js";
import { assertDesktopProtocolVersion, assertDesktopTaskPack } from "./contracts.js";
import { heartbeatDesktopAgent, registerDesktopAgent } from "./agent-registry.js";

export type DesktopServerMessage =
  | { version: 1; type: "task"; pack: DesktopTaskPack }
  | { version: 1; type: "accepted"; sessionId: string };

export type DesktopClientMessage =
  | { version: 1; type: "heartbeat"; at: string }
  | { version: 1; type: "result"; result: DesktopJobResult };

export interface DesktopAgentWire {
  send(message: DesktopServerMessage): void;
  close(reason?: string): void;
}

export type DesktopAgentSession = {
  sessionId: string;
  agentId: string;
  connectedAt: string;
  wire: DesktopAgentWire;
};

type DeferredResult = {
  promise: Promise<DesktopJobResult>;
  resolve(result: DesktopJobResult): void;
};

export type DesktopAgentTransportOptions = {
  registryRoot: string;
  expectedToken: string;
  now?: () => string;
};

function tokenMatches(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createDesktopAgentTransport(options: DesktopAgentTransportOptions) {
  if (!options.expectedToken) throw new Error("Desktop Agent authentication token is required");
  const now = options.now ?? (() => new Date().toISOString());
  const sessionsById = new Map<string, DesktopAgentSession>();
  const sessionByAgent = new Map<string, string>();
  const pending = new Map<string, DeferredResult>();
  const completed = new Map<string, DesktopJobResult>();

  async function acceptHello(
    sessionId: string,
    hello: DesktopAgentHello,
    wire: DesktopAgentWire,
  ): Promise<DesktopAgentSession> {
    assertDesktopProtocolVersion(hello.version);
    if (!tokenMatches(options.expectedToken, hello.token)) {
      throw new Error("Desktop Agent authentication failed");
    }
    const previousId = sessionByAgent.get(hello.agentId);
    if (previousId) {
      const previous = sessionsById.get(previousId);
      previous?.wire.close("replaced by newer Desktop Agent session");
      sessionsById.delete(previousId);
    }
    const at = now();
    await registerDesktopAgent(options.registryRoot, hello, at);
    const session = { sessionId, agentId: hello.agentId, connectedAt: at, wire };
    sessionsById.set(sessionId, session);
    sessionByAgent.set(hello.agentId, sessionId);
    return session;
  }

  async function handleMessage(sessionId: string, message: DesktopClientMessage): Promise<void> {
    assertDesktopProtocolVersion(message.version);
    const session = sessionsById.get(sessionId);
    if (!session) throw new Error(`Desktop Agent session not found: ${sessionId}`);
    if (message.type === "heartbeat") {
      await heartbeatDesktopAgent(options.registryRoot, session.agentId, message.at);
      return;
    }
    const waiting = pending.get(message.result.jobId);
    if (!waiting) throw new Error(`Unknown Desktop Job result: ${message.result.jobId}`);
    if (message.result.agentId !== session.agentId) {
      throw new Error(`Desktop Job result agent mismatch: ${message.result.jobId}`);
    }
    pending.delete(message.result.jobId);
    waiting.resolve(message.result);
  }

  function disconnect(sessionId: string): void {
    const session = sessionsById.get(sessionId);
    if (!session) return;
    sessionsById.delete(sessionId);
    if (sessionByAgent.get(session.agentId) === sessionId) {
      sessionByAgent.delete(session.agentId);
    }
  }

  function getAgentSessionId(agentId: string): string | null {
    const sessionId = sessionByAgent.get(agentId);
    return sessionId && sessionsById.has(sessionId) ? sessionId : null;
  }

  function isAgentConnected(agentId: string): boolean {
    const sessionId = sessionByAgent.get(agentId);
    return sessionId !== undefined && sessionsById.has(sessionId);
  }

  function sendTask(agentId: string, pack: DesktopTaskPack): void {
    assertDesktopTaskPack(pack);
    if (pack.agentId !== agentId) throw new Error(`Desktop Task Pack agent mismatch: ${pack.agentId}`);
    const sessionId = sessionByAgent.get(agentId);
    const session = sessionId ? sessionsById.get(sessionId) : undefined;
    if (!session) throw new Error(`Desktop Agent is not connected: ${agentId}`);
    if (pending.has(pack.jobId)) throw new Error(`Desktop Job already awaiting result: ${pack.jobId}`);
    let resolveResult!: (result: DesktopJobResult) => void;
    const promise = new Promise<DesktopJobResult>((resolve) => { resolveResult = resolve; });
    pending.set(pack.jobId, { promise, resolve: resolveResult });
    session.wire.send({ version: 1, type: "task", pack });
  }

  async function awaitResult(jobId: string, timeoutMs: number): Promise<DesktopJobResult> {
    const done = completed.get(jobId);
    if (done) return done;
    const waiting = pending.get(jobId);
    if (!waiting) throw new Error(`Desktop Job is not awaiting a result: ${jobId}`);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        waiting.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`Desktop Job result timeout: ${jobId}`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    acceptHello,
    handleMessage,
    disconnect,
    isAgentConnected,
    getAgentSessionId,
    sendTask,
    awaitResult,
  };
}

export type DesktopAgentTransport = ReturnType<typeof createDesktopAgentTransport>;

export async function acceptDesktopAgentHello(
  transport: DesktopAgentTransport,
  sessionId: string,
  hello: DesktopAgentHello,
  wire: DesktopAgentWire,
) {
  return transport.acceptHello(sessionId, hello, wire);
}

export async function handleDesktopAgentMessage(
  transport: DesktopAgentTransport,
  sessionId: string,
  message: DesktopClientMessage,
) {
  return transport.handleMessage(sessionId, message);
}
