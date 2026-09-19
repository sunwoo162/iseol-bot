import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { startIseolRuntimeServices, type IseolRuntimeServices } from "../src/runtime/iseol-runtime-services.js";

export type IseolRuntimeHostConfig = {
  dataRoot: string;
  modelRoot: string;
  runRoot: string;
  webWorkerRoot: string;
  browserProfileRoot: string;
  lockPath: string;
};

export function loadRuntimeHostConfig(path = process.env.ISEOL_RUNTIME_CONFIG ?? "iseol-runtime.json"): IseolRuntimeHostConfig {
  if (!existsSync(path)) throw new Error(`runtime configuration is missing: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<IseolRuntimeHostConfig>;
  const required = ["dataRoot", "modelRoot", "runRoot", "webWorkerRoot", "browserProfileRoot"] as const;
  for (const key of required) {
    if (typeof raw[key] !== "string" || !raw[key].trim()) throw new Error(`runtime configuration field is missing: ${key}`);
  }
  const dataRoot = resolve(raw.dataRoot!);
  return {
    dataRoot,
    modelRoot: resolve(raw.modelRoot!),
    runRoot: resolve(raw.runRoot!),
    webWorkerRoot: resolve(raw.webWorkerRoot!),
    browserProfileRoot: resolve(raw.browserProfileRoot!),
    lockPath: resolve(raw.lockPath ?? `${dataRoot}/runtime/iseol-runtime.lock`),
  };
}

export async function acquireRuntimeLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  let handle: FileHandle;
  try { handle = await open(path, "wx"); }
  catch { throw new Error("another Iseol runtime already owns this configuration"); }
  await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return async () => { await handle.close(); await rm(path, { force: true }); };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const config = loadRuntimeHostConfig();
  if (command === "status") {
    try { process.stdout.write(await readFile(config.lockPath, "utf8")); }
    catch { process.stdout.write(JSON.stringify({ state: "stopped" })); }
    return;
  }
  if (command !== "start") throw new Error(`unsupported runtime host command: ${command}`);
  const release = await acquireRuntimeLock(config.lockPath);
  let services: IseolRuntimeServices | undefined;
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await services?.dispose();
    await release();
  };
  process.once("SIGINT", () => { void stop().finally(() => process.exit(130)); });
  process.once("SIGTERM", () => { void stop().finally(() => process.exit(143)); });
  try {
    const env = {
      ...process.env,
      ISEOL_MODEL_ROOT: config.modelRoot,
      ISEOL_RUN_ROOT: config.runRoot,
      ISEOL_CHATGPT_WEB_ROOT: config.webWorkerRoot,
      ISEOL_CHATGPT_BROWSER_PROFILE_ROOT: config.browserProfileRoot,
    };
    services = await startIseolRuntimeServices({ env, roots: {
      iseolRoot: config.dataRoot,
      modelRoot: config.modelRoot,
      runRoot: config.runRoot,
      webRoot: config.dataRoot,
      webWorkerRoot: config.webWorkerRoot,
      browserProfileRoot: config.browserProfileRoot,
    } });
    process.stdout.write(JSON.stringify({ state: "running", pid: process.pid, dataRoot: config.dataRoot }) + "\n");
    await new Promise<void>(() => undefined);
  } finally {
    await stop();
  }
}

if (process.argv[1]?.endsWith("iseol-runtime-host.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "runtime host failed"); process.exitCode = 1; });
