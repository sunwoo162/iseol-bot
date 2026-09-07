import { resolve } from "node:path";
import { assertDesktopAgentId } from "./agent-registry.js";
import { executeDesktopTaskPack } from "./runtime.js";
import { connectDesktopAgentWebSocketClient } from "./ws-client.js";

export type DesktopAgentClientConfig = {
  url: string;
  token: string;
  agentId: string;
  workspaceRoots: string[];
  heartbeatIntervalMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
};

type AgentEnv = Record<string, string | undefined>;

type DesktopAgentConnection = {
  close(): Promise<void>;
  closed: Promise<void>;
};

type PersistentAgentDeps = {
  signal?: AbortSignal;
  connect?: typeof connectDesktopAgentWebSocketClient;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};
function required(env: AgentEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function assertSecureAgentUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Desktop Agent wss:// transport is required for public connections");
  }
  return url.toString();
}

export function resolveDesktopAgentClientConfig(env: AgentEnv): DesktopAgentClientConfig {
  const url = assertSecureAgentUrl(required(env, "ISEOL_DESKTOP_AGENT_URL"));
  const token = required(env, "ISEOL_DESKTOP_AGENT_TOKEN");
  const agentId = required(env, "ISEOL_DESKTOP_AGENT_ID");
  assertDesktopAgentId(agentId);
  const roots = required(env, "ISEOL_DESKTOP_AGENT_WORKSPACE_ROOTS")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
  if (roots.length === 0) throw new Error("ISEOL_DESKTOP_AGENT_WORKSPACE_ROOTS is required");
  const heartbeatIntervalMs = positiveInt(env.ISEOL_DESKTOP_AGENT_HEARTBEAT_MS, 5_000, "ISEOL_DESKTOP_AGENT_HEARTBEAT_MS");
  const reconnectBaseMs = positiveInt(env.ISEOL_DESKTOP_AGENT_RECONNECT_BASE_MS, 1_000, "ISEOL_DESKTOP_AGENT_RECONNECT_BASE_MS");
  const reconnectMaxMs = positiveInt(env.ISEOL_DESKTOP_AGENT_RECONNECT_MAX_MS, 30_000, "ISEOL_DESKTOP_AGENT_RECONNECT_MAX_MS");
  if (reconnectMaxMs < reconnectBaseMs) {
    throw new Error("ISEOL_DESKTOP_AGENT_RECONNECT_MAX_MS must be >= reconnect base");
  }
  return {
    url,
    token,
    agentId,
    workspaceRoots: [...new Set(roots)],
    heartbeatIntervalMs,
    reconnectBaseMs,
    reconnectMaxMs,
  };
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

async function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => undefined);
  if (signal.aborted) return;
  await new Promise<void>((resolveAbort) => {
    signal.addEventListener("abort", () => resolveAbort(), { once: true });
  });
}
export async function runPersistentDesktopAgent(
  config: DesktopAgentClientConfig,
  deps: PersistentAgentDeps = {},
): Promise<void> {
  const connect = deps.connect ?? connectDesktopAgentWebSocketClient;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)));
  const random = deps.random ?? Math.random;
  let failures = 0;

  while (!aborted(deps.signal)) {
    let connection: DesktopAgentConnection | null = null;
    try {
      connection = await connect({
        url: config.url,
        hello: {
          version: 1,
          agentId: config.agentId,
          agentVersion: "0.1.0",
          os: process.platform,
          capabilities: ["files", "process", "git", "http"],
          workspaceRoots: config.workspaceRoots,
          token: config.token,
        },
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        onTask: (pack) => executeDesktopTaskPack(pack, { allowedRoots: config.workspaceRoots }),
      }) as DesktopAgentConnection;
      failures = 0;
      if (aborted(deps.signal)) {
        await connection.close();
        return;
      }
      await Promise.race([connection.closed, waitForAbort(deps.signal)]);
      if (aborted(deps.signal)) {
        await connection.close();
        return;
      }
    } catch {
      if (aborted(deps.signal)) return;
    }

    const baseDelay = Math.min(config.reconnectMaxMs, config.reconnectBaseMs * (2 ** failures));
    failures += 1;
    const delay = Math.min(config.reconnectMaxMs, baseDelay + Math.floor(baseDelay * 0.2 * random()));
    await sleep(delay);
  }
}
