import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { DesktopAgentHello, DesktopAgentPresence } from "./contracts.js";
import { assertDesktopProtocolVersion } from "./contracts.js";
import { renameWithTransientRetry } from "./atomic-file.js";

export type ResolvedDesktopAgentPresence = DesktopAgentPresence & {
  status: "online" | "offline";
};

export function assertDesktopAgentId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    throw new Error(`Invalid Desktop Agent id: ${id}`);
  }
}

function agentFile(root: string, agentId: string): string {
  assertDesktopAgentId(agentId);
  return resolve(root, "agents", `${agentId}.json`);
}

const agentWriteQueues = new Map<string, Promise<unknown>>();

async function serializeAgentWrite<T>(root: string, agentId: string, action: () => Promise<T>): Promise<T> {
  const key = agentFile(root, agentId);
  const previous = agentWriteQueues.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(action);
  agentWriteQueues.set(key, run);
  try { return await run; }
  finally { if (agentWriteQueues.get(key) === run) agentWriteQueues.delete(key); }
}

async function loadRawPresence(root: string, agentId: string): Promise<DesktopAgentPresence | null> {
  const path = agentFile(root, agentId);
  try {
    return JSON.parse(await readFile(path, "utf8")) as DesktopAgentPresence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function saveRawPresence(root: string, presence: DesktopAgentPresence): Promise<void> {
  const path = agentFile(root, presence.agentId);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(presence, null, 2), "utf8");
  try { await renameWithTransientRetry(temp, path); }
  catch (error) { await unlink(temp).catch(() => undefined); throw error; }
}

function normalizeRoots(roots: string[]): string[] {
  if (roots.length === 0) throw new Error("Desktop Agent requires at least one workspace root");
  return [...new Set(roots.map((item) => {
    if (!item.trim()) throw new Error("Desktop Agent workspace root cannot be empty");
    return resolve(item);
  }))];
}

export async function registerDesktopAgent(
  root: string,
  hello: DesktopAgentHello,
  at: string,
): Promise<DesktopAgentPresence> {
  return serializeAgentWrite(root, hello.agentId, async () => {
    assertDesktopProtocolVersion(hello.version);
    assertDesktopAgentId(hello.agentId);
    const existing = await loadRawPresence(root, hello.agentId);
    const presence: DesktopAgentPresence = {
      version: 1, agentId: hello.agentId, agentVersion: hello.agentVersion, os: hello.os,
      capabilities: [...hello.capabilities], workspaceRoots: normalizeRoots(hello.workspaceRoots),
      registeredAt: existing?.registeredAt ?? at, lastHeartbeatAt: at,
    };
    await saveRawPresence(root, presence);
    return presence;
  });
}

export async function heartbeatDesktopAgent(
  root: string,
  agentId: string,
  at: string,
): Promise<DesktopAgentPresence> {
  return serializeAgentWrite(root, agentId, async () => {
    const presence = await loadRawPresence(root, agentId);
    if (!presence) throw new Error(`Desktop Agent not registered: ${agentId}`);
    const next = { ...presence, lastHeartbeatAt: at };
    await saveRawPresence(root, next);
    return next;
  });
}

export async function getDesktopAgentPresence(
  root: string,
  agentId: string,
  now: string,
  timeoutMs: number,
): Promise<ResolvedDesktopAgentPresence | null> {
  const presence = await loadRawPresence(root, agentId);
  if (!presence) return null;
  const age = Date.parse(now) - Date.parse(presence.lastHeartbeatAt);
  return { ...presence, status: age <= timeoutMs ? "online" : "offline" };
}

export async function listOnlineDesktopAgents(
  root: string,
  now: string,
  timeoutMs: number,
): Promise<ResolvedDesktopAgentPresence[]> {
  const directory = resolve(root, "agents");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: ResolvedDesktopAgentPresence[] = [];
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const agentId = name.slice(0, -5);
    const presence = await getDesktopAgentPresence(root, agentId, now, timeoutMs);
    if (presence?.status === "online") result.push(presence);
  }
  return result.sort((a, b) => a.agentId.localeCompare(b.agentId));
}
