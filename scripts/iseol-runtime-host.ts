import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rm, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { startIseolRuntimeServices, type IseolRuntimeServices } from "../src/runtime/iseol-runtime-services.js";
import { loadHarnessRun } from "../src/harness/run-store.js";
import { listDesktopJobs, loadDesktopJob } from "../src/desktop-agent/job-store.js";
import { containDesktopJobAsOperator, inspectDesktopJobReconciliation, issueDesktopJobContainmentApproval } from "../src/desktop-agent/operator-reconciliation.js";

export type IseolRuntimeHostConfig = {
  version: 1;
  dataRoot: string;
  modelRoot: string;
  runRoot: string;
  webWorkerRoot: string;
  browserProfileRoot: string;
  lockPath: string;
  codeVersion?: string;
  projectRuntimeEnabled?: boolean;
  desktopAgentId?: string;
  projectModelRoot?: string;
  projectRunRoot?: string;
  projectWebWorkerRoot?: string;
  projectDesktopStateRoot?: string;
};

function overlaps(left: string, right: string): boolean {
  const inside = (root: string, target: string) => {
    const relation = relative(resolve(root), resolve(target));
    return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
  };
  return inside(left, right) || inside(right, left);
}

function validateProjectRoots(config: Pick<IseolRuntimeHostConfig, "modelRoot" | "runRoot" | "webWorkerRoot" | "browserProfileRoot" | "projectModelRoot" | "projectRunRoot" | "projectWebWorkerRoot" | "projectDesktopStateRoot">): void {
  const projectEntries = [
    ["projectModelRoot", config.projectModelRoot],
    ["projectRunRoot", config.projectRunRoot],
    ["projectWebWorkerRoot", config.projectWebWorkerRoot],
    ["projectDesktopStateRoot", config.projectDesktopStateRoot],
  ] as const;
  const existingEntries = [
    ["modelRoot", config.modelRoot],
    ["runRoot", config.runRoot],
    ["webWorkerRoot", config.webWorkerRoot],
    ["browserProfileRoot", config.browserProfileRoot],
  ] as const;
  for (const [projectName, projectRoot] of projectEntries) {
    if (!projectRoot) continue;
    for (const [existingName, existingRoot] of existingEntries) {
      if (overlaps(projectRoot, existingRoot)) throw new Error(`project root overlap: ${projectName} and ${existingName}`);
    }
  }
  for (let index = 0; index < projectEntries.length; index += 1) {
    const [leftName, leftRoot] = projectEntries[index]!;
    if (!leftRoot) continue;
    for (let next = index + 1; next < projectEntries.length; next += 1) {
      const [rightName, rightRoot] = projectEntries[next]!;
      if (rightRoot && overlaps(leftRoot, rightRoot)) throw new Error(`project root overlap: ${leftName} and ${rightName}`);
    }
  }
}

export function loadRuntimeHostConfig(path = process.env.ISEOL_RUNTIME_CONFIG ?? "iseol-runtime.json"): IseolRuntimeHostConfig {
  if (!existsSync(path)) throw new Error(`runtime configuration is missing: ${path}`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<IseolRuntimeHostConfig>;
  const required = ["dataRoot", "modelRoot", "runRoot", "webWorkerRoot", "browserProfileRoot"] as const;
  for (const key of required) {
    if (typeof raw[key] !== "string" || !raw[key].trim()) throw new Error(`runtime configuration field is missing: ${key}`);
  }
  const dataRoot = resolve(raw.dataRoot!);
  const projectRuntimeEnabled = raw.projectRuntimeEnabled;
  if (projectRuntimeEnabled !== undefined && typeof projectRuntimeEnabled !== "boolean") {
    throw new Error("runtime configuration field must be boolean: projectRuntimeEnabled");
  }
  if (raw.desktopAgentId !== undefined && (typeof raw.desktopAgentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw.desktopAgentId))) {
    throw new Error("runtime configuration field is invalid: desktopAgentId");
  }
  const config = {
    version: 1,
    dataRoot,
    modelRoot: resolve(raw.modelRoot!),
    runRoot: resolve(raw.runRoot!),
    webWorkerRoot: resolve(raw.webWorkerRoot!),
    browserProfileRoot: resolve(raw.browserProfileRoot!),
    lockPath: resolve(raw.lockPath ?? `${dataRoot}/runtime/iseol-runtime.lock`),
    ...(typeof raw.codeVersion === "string" && raw.codeVersion.trim() ? { codeVersion: raw.codeVersion.trim().slice(0, 80) } : {}),
    ...(projectRuntimeEnabled === undefined ? {} : { projectRuntimeEnabled }),
    ...(typeof raw.desktopAgentId === "string" ? { desktopAgentId: raw.desktopAgentId } : {}),
    ...(typeof raw.projectModelRoot === "string" && raw.projectModelRoot.trim() ? { projectModelRoot: resolve(raw.projectModelRoot) } : {}),
    ...(typeof raw.projectRunRoot === "string" && raw.projectRunRoot.trim() ? { projectRunRoot: resolve(raw.projectRunRoot) } : {}),
    ...(typeof raw.projectWebWorkerRoot === "string" && raw.projectWebWorkerRoot.trim() ? { projectWebWorkerRoot: resolve(raw.projectWebWorkerRoot) } : {}),
    ...(typeof raw.projectDesktopStateRoot === "string" && raw.projectDesktopStateRoot.trim() ? { projectDesktopStateRoot: resolve(raw.projectDesktopStateRoot) } : {}),
  };
  validateProjectRoots(config);
  return config;
}

export async function saveRuntimeHostConfig(path: string, config: Omit<IseolRuntimeHostConfig, "version"> & { version?: 1 }): Promise<void> {
  const normalized = {
    version: 1 as const,
    dataRoot: resolve(config.dataRoot),
    modelRoot: resolve(config.modelRoot),
    runRoot: resolve(config.runRoot),
    webWorkerRoot: resolve(config.webWorkerRoot),
    browserProfileRoot: resolve(config.browserProfileRoot),
    lockPath: resolve(config.lockPath),
    ...(config.codeVersion ? { codeVersion: config.codeVersion.slice(0, 80) } : {}),
    ...(config.projectRuntimeEnabled === undefined ? {} : { projectRuntimeEnabled: config.projectRuntimeEnabled }),
    ...(config.desktopAgentId ? { desktopAgentId: config.desktopAgentId } : {}),
    ...(config.projectModelRoot ? { projectModelRoot: resolve(config.projectModelRoot) } : {}),
    ...(config.projectRunRoot ? { projectRunRoot: resolve(config.projectRunRoot) } : {}),
    ...(config.projectWebWorkerRoot ? { projectWebWorkerRoot: resolve(config.projectWebWorkerRoot) } : {}),
    ...(config.projectDesktopStateRoot ? { projectDesktopStateRoot: resolve(config.projectDesktopStateRoot) } : {}),
  };
  validateProjectRoots(normalized);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, JSON.stringify(normalized, null, 2), "utf8");
  await rename(temporary, path);
}

export function runtimeMaintenanceLockPath(runtimeLockPath: string): string {
  return resolve(dirname(runtimeLockPath), "iseol-maintenance.lock");
}

async function assertNoMaintenanceOwnership(runtimeLockPath: string): Promise<void> {
  const maintenancePath = runtimeMaintenanceLockPath(runtimeLockPath);
  try {
    await readFile(maintenancePath, "utf8");
    throw new Error("maintenance ownership is active; refusing Runtime startup");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function acquireRuntimeMaintenanceLock(
  runtimeLockPath: string,
  maintenancePath = runtimeMaintenanceLockPath(runtimeLockPath),
  metadata: { dataRoot?: string; codeVersion?: string } = {},
): Promise<() => Promise<void>> {
  try {
    await readFile(runtimeLockPath, "utf8");
    throw new Error("Runtime ownership is active; maintenance mode requires a stopped Runtime");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(maintenancePath), { recursive: true });
  let handle: FileHandle;
  try { handle = await open(maintenancePath, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("maintenance ownership already exists; refusing takeover");
    throw error;
  }
  await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString(), ...metadata }));
  return async () => { await handle.close(); await rm(maintenancePath, { force: true }); };
}

export async function acquireRuntimeLock(path: string, metadata: { dataRoot?: string; codeVersion?: string } = {}): Promise<() => Promise<void>> {
  await assertNoMaintenanceOwnership(path);
  await mkdir(dirname(path), { recursive: true });
  let handle: FileHandle;
  try { handle = await open(path, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let ownerPid: number | null = null;
    try {
      const lock = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
      ownerPid = Number.isInteger(lock.pid) && (lock.pid as number) > 0 ? lock.pid as number : null;
    } catch {
      throw new Error("runtime lock is unreadable; refusing to remove it");
    }
    if (ownerPid !== null) {
      try { process.kill(ownerPid, 0); } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code !== "ESRCH") {
          throw new Error("another Iseol runtime already owns this configuration");
        }
        await rm(path, { force: true });
        try { handle = await open(path, "wx"); }
        catch { throw new Error("runtime lock changed while reclaiming stale ownership"); }
      }
    }
    if (!handle!) throw new Error("another Iseol runtime already owns this configuration");
  }
  await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, startedAt: new Date().toISOString(), ...metadata }));
  return async () => { await handle.close(); await rm(path, { force: true }); };
}

export async function readRuntimeHostStatus(config: IseolRuntimeHostConfig): Promise<Record<string, unknown>> {
  try {
    const lock = JSON.parse(await readFile(config.lockPath, "utf8")) as Record<string, unknown>;
    return { state: "running", configVersion: config.version, dataRoot: config.dataRoot, codeVersion: config.codeVersion ?? "unknown", ...lock };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "stopped", configVersion: config.version, dataRoot: config.dataRoot, codeVersion: config.codeVersion ?? "unknown" };
    throw error;
  }
}

export async function inspectRuntimeMaintenanceJob(config: IseolRuntimeHostConfig, input: { projectId: string; jobId: string; now: string }) {
  if (!config.projectRunRoot || !config.projectDesktopStateRoot) throw new Error("Project Desktop maintenance roots are not configured");
  const job = await loadDesktopJob(config.projectDesktopStateRoot, input.jobId);
  if (!job) return null;
  const run = await loadHarnessRun(config.projectRunRoot, job.runId);
  if (!run || run.request.projectId !== input.projectId) throw new Error("Desktop job does not belong to the requested Project Workspace");
  return inspectDesktopJobReconciliation({ root: config.projectDesktopStateRoot, jobId: input.jobId, now: input.now });
}

export async function containRuntimeMaintenanceJob(config: IseolRuntimeHostConfig, input: {
  projectId: string; jobId: string; expectedRevision: string; operationId: string; approvalId: string; at: string;
}): Promise<Awaited<ReturnType<typeof containDesktopJobAsOperator>>> {
  if (!config.projectRunRoot || !config.projectDesktopStateRoot) throw new Error("Project Desktop maintenance roots are not configured");
  const release = await acquireRuntimeMaintenanceLock(config.lockPath, runtimeMaintenanceLockPath(config.lockPath), { dataRoot: config.dataRoot, ...(config.codeVersion ? { codeVersion: config.codeVersion } : {}) });
  try {
    const activeLease = config.projectDesktopStateRoot
      ? (await listDesktopJobs(config.projectDesktopStateRoot)).find((job) => job.lease && Date.parse(job.lease.expiresAt) > Date.parse(input.at))
      : undefined;
    if (activeLease) return { status: "rejected", reason: "active-desktop-lease" };
    const job = await loadDesktopJob(config.projectDesktopStateRoot, input.jobId);
    if (!job) return { status: "rejected", reason: "job-not-found" };
    const run = await loadHarnessRun(config.projectRunRoot, job.runId);
    if (!run || run.request.projectId !== input.projectId) return { status: "rejected", reason: "job-not-found-or-project-mismatch" };
    return containDesktopJobAsOperator({ root: config.projectDesktopStateRoot, jobId: input.jobId, expectedRevision: input.expectedRevision, operationId: input.operationId, approvalId: input.approvalId, at: input.at, actor: "operator" });
  } finally {
    await release();
  }
}

function equalSecret(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function approveAndContainRuntimeMaintenanceJob(config: IseolRuntimeHostConfig, input: {
  projectId: string; jobId: string; expectedRevision: string; requestId: string; operationId: string;
  operatorToken: string; configuredOperatorToken: string; operatorId: string; confirmation: string; at: string; expiresAt: string;
}) {
  if (!config.projectRunRoot || !config.projectDesktopStateRoot) throw new Error("Project Desktop maintenance roots are not configured");
  const release = await acquireRuntimeMaintenanceLock(config.lockPath, runtimeMaintenanceLockPath(config.lockPath), { dataRoot: config.dataRoot, ...(config.codeVersion ? { codeVersion: config.codeVersion } : {}) });
  try {
    if (!input.operatorId || !input.configuredOperatorToken || !equalSecret(input.operatorToken, input.configuredOperatorToken)) {
      return { status: "rejected" as const, reason: "operator-authentication-failed" };
    }
    const activeLease = (await listDesktopJobs(config.projectDesktopStateRoot)).find((job) => job.lease && Date.parse(job.lease.expiresAt) > Date.parse(input.at));
    if (activeLease) return { status: "rejected" as const, reason: "active-desktop-lease" };
    const inspection = await inspectRuntimeMaintenanceJob(config, { projectId: input.projectId, jobId: input.jobId, now: input.at });
    if (!inspection) return { status: "rejected" as const, reason: "job-not-found" };
    if (inspection.revision !== input.expectedRevision) return { status: "rejected" as const, reason: "job-revision-mismatch", inspection };
    if (inspection.contained) return { status: "already-contained" as const, inspection };
    if (!inspection.canContain) return { status: "rejected" as const, reason: inspection.blockers.join(","), inspection };
    const expectedConfirmation = `I approve containment of ${input.jobId} at revision ${input.expectedRevision}`;
    if (input.confirmation !== expectedConfirmation) return { status: "rejected" as const, reason: "operator-confirmation-required", inspection };
    const job = await loadDesktopJob(config.projectDesktopStateRoot, input.jobId);
    if (!job) return { status: "rejected" as const, reason: "job-not-found" };
    const approval = await issueDesktopJobContainmentApproval({
      root: config.projectDesktopStateRoot, requestId: input.requestId, jobId: input.jobId, runId: job.runId,
      revision: input.expectedRevision, issuedAt: input.at, expiresAt: input.expiresAt, issuedBy: input.operatorId,
    });
    const containment = await containDesktopJobAsOperator({
      root: config.projectDesktopStateRoot, jobId: input.jobId, expectedRevision: input.expectedRevision,
      operationId: input.operationId, approvalId: approval.approvalId, at: input.at, actor: "operator",
    });
    return { ...containment, approvalId: approval.approvalId };
  } finally {
    await release();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "start";
  const config = loadRuntimeHostConfig();
  if (command === "status") {
    process.stdout.write(JSON.stringify(await readRuntimeHostStatus(config)));
    return;
  }
  if (command === "stop") {
    const raw = await readFile(config.lockPath, "utf8").catch(() => "");
    if (!raw) { process.stdout.write(JSON.stringify({ state: "stopped" })); return; }
    const lock = JSON.parse(raw) as { pid?: unknown };
    if (!Number.isInteger(lock.pid) || (lock.pid as number) <= 0) throw new Error("runtime lock has invalid owner");
    process.kill(lock.pid as number, "SIGTERM");
    process.stdout.write(JSON.stringify({ state: "stop-requested", pid: lock.pid }));
    return;
  }
  if (command === "maintenance-status") {
    const runtime = await readRuntimeHostStatus(config);
    let maintenance: Record<string, unknown> = { state: "stopped" };
    try { maintenance = JSON.parse(await readFile(runtimeMaintenanceLockPath(config.lockPath), "utf8")) as Record<string, unknown>; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    process.stdout.write(JSON.stringify({ runtime, maintenance }));
    return;
  }
  if (command === "maintenance-inspect") {
    const [projectId, jobId] = process.argv.slice(3);
    if (!projectId || !jobId) throw new Error("maintenance-inspect requires projectId and jobId");
    process.stdout.write(JSON.stringify(await inspectRuntimeMaintenanceJob(config, { projectId, jobId, now: new Date().toISOString() })));
    return;
  }
  if (command === "maintenance-contain") {
    const [projectId, jobId, expectedRevision, operationId, approvalId] = process.argv.slice(3);
    if (!projectId || !jobId || !expectedRevision || !operationId || !approvalId) throw new Error("maintenance-contain requires projectId, jobId, expectedRevision, operationId and approvalId");
    process.stdout.write(JSON.stringify(await containRuntimeMaintenanceJob(config, { projectId, jobId, expectedRevision, operationId, approvalId, at: new Date().toISOString() })));
    return;
  }
  if (command === "maintenance-approve-contain") {
    const [projectId, jobId, expectedRevision, requestId, operationId, expiresAt] = process.argv.slice(3);
    if (!projectId || !jobId || !expectedRevision || !requestId || !operationId || !expiresAt) {
      throw new Error("maintenance-approve-contain requires projectId, jobId, expectedRevision, requestId, operationId and expiresAt");
    }
    const inspection = await inspectRuntimeMaintenanceJob(config, { projectId, jobId, now: new Date().toISOString() });
    process.stderr.write(`${JSON.stringify(inspection)}\n`);
    const input = JSON.parse(await readFile(0, "utf8")) as { operatorToken?: unknown; confirmation?: unknown };
    const operatorToken = typeof input.operatorToken === "string" ? input.operatorToken : "";
    const confirmation = typeof input.confirmation === "string" ? input.confirmation : "";
    const configuredOperatorToken = process.env.ISEOL_OPERATOR_TOKEN ?? "";
    const operatorId = process.env.ISEOL_OPERATOR_ID ?? "";
    process.stdout.write(JSON.stringify(await approveAndContainRuntimeMaintenanceJob(config, {
      projectId, jobId, expectedRevision, requestId, operationId, expiresAt,
      operatorToken, configuredOperatorToken, operatorId, confirmation, at: new Date().toISOString(),
    })));
    return;
  }
  if (command !== "start") throw new Error(`unsupported runtime host command: ${command}`);
  const release = await acquireRuntimeLock(config.lockPath, { dataRoot: config.dataRoot, ...(config.codeVersion ? { codeVersion: config.codeVersion } : {}) });
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
      ...(config.projectRuntimeEnabled === undefined ? {} : { ISEOL_PROJECT_RUNTIME_ENABLED: String(config.projectRuntimeEnabled) }),
      ...(config.desktopAgentId ? { ISEOL_PROJECT_AGENT_ID: config.desktopAgentId } : {}),
      ...(config.projectModelRoot ? { ISEOL_PROJECT_MODEL_ROOT: config.projectModelRoot } : {}),
      ...(config.projectRunRoot ? { ISEOL_PROJECT_RUN_ROOT: config.projectRunRoot } : {}),
      ...(config.projectWebWorkerRoot ? { ISEOL_PROJECT_WEB_WORKER_ROOT: config.projectWebWorkerRoot } : {}),
      ...(config.projectDesktopStateRoot ? { ISEOL_PROJECT_DESKTOP_STATE_ROOT: config.projectDesktopStateRoot } : {}),
    };
    services = await startIseolRuntimeServices({ env, roots: {
      iseolRoot: config.dataRoot,
      modelRoot: config.modelRoot,
      runRoot: config.runRoot,
      webRoot: config.dataRoot,
      webWorkerRoot: config.webWorkerRoot,
      browserProfileRoot: config.browserProfileRoot,
      ...(config.projectModelRoot ? { projectModelRoot: config.projectModelRoot } : {}),
      ...(config.projectRunRoot ? { projectRunRoot: config.projectRunRoot } : {}),
      ...(config.projectWebWorkerRoot ? { projectWebWorkerRoot: config.projectWebWorkerRoot } : {}),
      ...(config.projectDesktopStateRoot ? { projectDesktopStateRoot: config.projectDesktopStateRoot } : {}),
    } });
    process.stdout.write(JSON.stringify({ state: "running", pid: process.pid, dataRoot: config.dataRoot }) + "\n");
    await new Promise<void>(() => undefined);
  } finally {
    await stop();
  }
}

if (process.argv[1]?.endsWith("iseol-runtime-host.ts")) void main().catch((error) => { console.error(error instanceof Error ? error.message : "runtime host failed"); process.exitCode = 1; });
import "dotenv/config";
