import { spawn } from "node:child_process";
import { basename, relative } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import type {
  DesktopJobResult,
  DesktopOperation,
  DesktopOperationResult,
  DesktopTaskPack,
} from "./contracts.js";
import {
  assertDesktopTaskPack,
  desktopOperationMutates,
} from "./contracts.js";
import { assertWorkspaceAccess, verifyDesktopTaskPolicy } from "./workspace-guard.js";

export type DesktopRuntimeDependencies = {
  allowedRoots: string[];
  maxOutputBytes?: number;
  allowedExecutables?: string[];
  fetchImpl?: typeof fetch;
  now?: () => string;
};

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const DEFAULT_EXECUTABLES = new Set([
  "node", "node.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd",
  "yarn", "yarn.cmd", "git", "git.exe", "dotnet", "dotnet.exe",
  "java", "java.exe", "mvn", "mvn.cmd", "gradle", "gradle.bat",
]);

function capOutput(value: Buffer, maxBytes: number): string {
  return value.subarray(0, Math.max(0, maxBytes)).toString("utf8");
}

async function runCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  stdin?: string;
}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, input.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({
        code,
        stdout: capOutput(Buffer.concat(stdout), input.maxOutputBytes),
        stderr: capOutput(Buffer.concat(stderr), input.maxOutputBytes),
        timedOut,
      });
    });
    if (input.stdin !== undefined) child.stdin.end(input.stdin);
    else child.stdin.end();
  });
}

function executableAllowed(executable: string, configured?: string[]): boolean {
  const name = basename(executable).toLowerCase();
  if (configured?.length) {
    return configured.some((item) => item === executable || item.toLowerCase() === name);
  }
  return DEFAULT_EXECUTABLES.has(name);
}

function assertProcessRequest(executable: string, args: string[], configured?: string[]): void {
  if (!executableAllowed(executable, configured)) {
    throw new Error(`Desktop executable is not allowed: ${executable}`);
  }
  const name = basename(executable).toLowerCase();
  if ((name === "node" || name === "node.exe")
      && args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) {
    throw new Error("Desktop Node inline evaluation is not allowed");
  }
}

function commandOperationResult(
  operationId: string,
  command: CommandResult,
  successSummary: string,
): DesktopOperationResult {
  if (command.timedOut) {
    return {
      operationId,
      ok: false,
      summary: `${successSummary} timed out`,
      ...(command.stdout ? { stdout: command.stdout } : {}),
      ...(command.stderr ? { stderr: command.stderr } : {}),
    };
  }
  return {
    operationId,
    ok: command.code === 0,
    summary: command.code === 0 ? successSummary : `${successSummary} exited with code ${command.code}`,
    ...(command.stdout ? { stdout: command.stdout } : {}),
    ...(command.stderr ? { stderr: command.stderr } : {}),
  };
}

function validatePatchTarget(workspace: string, target: string, patch: string): void {
  const rel = relative(workspace, target).replaceAll("\\", "/");
  const lines = patch.split(/\r?\n/);
  const oldHeaders = lines.filter((line) => line.startsWith("--- "));
  const newHeaders = lines.filter((line) => line.startsWith("+++ "));
  if (oldHeaders.length !== 1 || newHeaders.length !== 1) {
    throw new Error("Desktop patch must contain exactly one file header pair");
  }
  const headerPath = (line: string) => line.slice(4).split("\t", 1)[0] ?? "";
  const oldPath = headerPath(oldHeaders[0]!);
  const newPath = headerPath(newHeaders[0]!);
  if (oldPath !== "/dev/null" && oldPath !== `a/${rel}`) {
    throw new Error(`Desktop patch old path does not match guarded target: ${oldPath}`);
  }
  if (newPath !== "/dev/null" && newPath !== `b/${rel}`) {
    throw new Error(`Desktop patch new path does not match guarded target: ${newPath}`);
  }
  for (const line of lines.filter((item) => item.startsWith("diff --git "))) {
    if (line !== `diff --git a/${rel} b/${rel}`) {
      throw new Error(`Desktop patch diff header escapes guarded target: ${line}`);
    }
  }
}

async function gitCommand(
  workspace: string,
  cwd: string,
  args: string[],
  maxOutputBytes: number,
): Promise<CommandResult> {
  return runCommand({
    executable: "git",
    args,
    cwd,
    timeoutMs: 30_000,
    maxOutputBytes,
  });
}

async function executeOperation(
  pack: DesktopTaskPack,
  operation: DesktopOperation,
  deps: DesktopRuntimeDependencies,
  maxOutputBytes: number,
): Promise<DesktopOperationResult> {
  const workspace = await assertWorkspaceAccess(deps.allowedRoots, pack.workspaceRoot, pack.workspaceRoot);

  if (operation.type === "READ_FILE") {
    const path = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.path);
    const content = await readFile(path, "utf8");
    return { operationId: operation.id, ok: true, summary: `Read ${operation.path}`, stdout: content };
  }
  if (operation.type === "LIST_DIRECTORY") {
    const path = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.path);
    const entries = await readdir(path, { withFileTypes: true });
    const output = entries
      .map((entry) => `${entry.isDirectory() ? "D" : "F"} ${entry.name}`)
      .sort()
      .join("\n");
    return { operationId: operation.id, ok: true, summary: `Listed ${entries.length} entries`, stdout: output };
  }

  if (operation.type === "APPLY_PATCH") {
    const target = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.path);
    validatePatchTarget(workspace, target, operation.patch);
    const command = await runCommand({
      executable: "git",
      args: ["apply", "--whitespace=nowarn", "-"],
      cwd: workspace,
      timeoutMs: 30_000,
      maxOutputBytes,
      stdin: operation.patch,
    });
    return commandOperationResult(operation.id, command, `Applied patch to ${operation.path}`);
  }

  if (operation.type === "RUN_PROCESS") {
    const cwd = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.cwd);
    assertProcessRequest(operation.executable, operation.args, deps.allowedExecutables);
    const command = await runCommand({
      executable: operation.executable,
      args: operation.args,
      cwd,
      timeoutMs: operation.timeoutMs,
      maxOutputBytes,
    });
    return commandOperationResult(operation.id, command, `Ran ${basename(operation.executable)}`);
  }

  if (operation.type === "GIT_STATUS") {
    const cwd = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.cwd);
    const command = await gitCommand(workspace, cwd, ["status", "--short"], maxOutputBytes);
    return commandOperationResult(operation.id, command, "Read Git status");
  }
  if (operation.type === "GIT_DIFF") {
    const cwd = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.cwd);
    const command = await gitCommand(workspace, cwd, ["diff", "--"], maxOutputBytes);
    return commandOperationResult(operation.id, command, "Read Git diff");
  }

  if (operation.type === "GIT_BRANCH") {
    const cwd = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.cwd);
    const command = await gitCommand(workspace, cwd, ["branch", "--show-current"], maxOutputBytes);
    return commandOperationResult(operation.id, command, "Read Git branch");
  }

  if (operation.type === "GIT_INSPECT") {
    const cwd = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.cwd);
    const head = await gitCommand(workspace, cwd, ["rev-parse", "HEAD"], maxOutputBytes);
    if (head.code !== 0) return commandOperationResult(operation.id, head, "Inspect Git HEAD");
    const parent = await gitCommand(workspace, cwd, ["rev-parse", "HEAD^"], maxOutputBytes);
    const subject = await gitCommand(workspace, cwd, ["show", "-s", "--format=%s", "HEAD"], maxOutputBytes);
    const branch = await gitCommand(workspace, cwd, ["branch", "--show-current"], maxOutputBytes);
    const status = await gitCommand(workspace, cwd, ["status", "--short"], maxOutputBytes);
    if (subject.code !== 0 || branch.code !== 0 || status.code !== 0) {
      const failed = subject.code !== 0 ? subject : branch.code !== 0 ? branch : status;
      return commandOperationResult(operation.id, failed, "Inspect Git identity");
    }
    const identity = {
      head: head.stdout.trim(),
      parent: parent.code === 0 ? parent.stdout.trim() : "",
      subject: subject.stdout.trim(),
      branch: branch.stdout.trim(),
      status: status.stdout,
    };
    return { operationId: operation.id, ok: true, summary: "Inspected Git identity", stdout: JSON.stringify(identity), reference: identity.head };
  }

  if (operation.type === "GIT_COMMIT") {
    const cwd = await assertWorkspaceAccess(deps.allowedRoots, workspace, operation.cwd);
    const add = await gitCommand(workspace, cwd, ["add", "-A"], maxOutputBytes);
    if (add.code !== 0) return commandOperationResult(operation.id, add, "Stage Git changes");
    const staged = await gitCommand(workspace, cwd, ["diff", "--cached", "--quiet"], maxOutputBytes);
    if (staged.code === 0) {
      return { operationId: operation.id, ok: false, summary: "Git commit has no staged changes" };
    }
    if (staged.code !== 1) return commandOperationResult(operation.id, staged, "Inspect staged Git changes");
    const commit = await gitCommand(workspace, cwd, ["commit", "-m", operation.message], maxOutputBytes);
    const result = commandOperationResult(operation.id, commit, "Created Git commit");
    if (!result.ok) return result;
    const head = await gitCommand(workspace, cwd, ["rev-parse", "HEAD"], maxOutputBytes);
    if (head.code === 0) result.reference = head.stdout.trim();
    return result;
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), operation.timeoutMs);
  try {
    const response = await fetchImpl(operation.url, { signal: controller.signal });
    return {
      operationId: operation.id,
      ok: response.ok,
      summary: `HTTP ${response.status} ${operation.url}`,
      reference: operation.url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function failureResult(
  pack: DesktopTaskPack,
  status: DesktopJobResult["status"],
  completedAt: string,
  operations: DesktopOperationResult[],
): DesktopJobResult {
  return {
    version: 1,
    jobId: pack.jobId,
    runId: pack.runId,
    agentId: pack.agentId,
    status,
    completedAt,
    operations,
  };
}

export async function executeDesktopTaskPack(
  pack: DesktopTaskPack,
  deps: DesktopRuntimeDependencies,
): Promise<DesktopJobResult> {
  assertDesktopTaskPack(pack);
  const now = deps.now ?? (() => new Date().toISOString());
  const maxOutputBytes = deps.maxOutputBytes ?? 64 * 1024;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`Desktop maxOutputBytes must be positive: ${maxOutputBytes}`);
  }

  const results: DesktopOperationResult[] = [];
  let policyVerified = false;
  for (const operation of pack.operations) {
    if (desktopOperationMutates(operation) && !policyVerified) {
      try {
        await verifyDesktopTaskPolicy(pack, deps.allowedRoots);
        policyVerified = true;
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        results.push({ operationId: operation.id, ok: false, summary });
        return failureResult(pack, "retryable-failure", now(), results);
      }
    }

    let result: DesktopOperationResult;
    try {
      result = await executeOperation(pack, operation, deps, maxOutputBytes);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      results.push({ operationId: operation.id, ok: false, summary });
      const protectedFailure = /outside Desktop|not allowed|inline evaluation|patch .*target/i.test(summary);
      return failureResult(pack, protectedFailure ? "final-failure" : "retryable-failure", now(), results);
    }
    results.push(result);
    if (!result.ok) return failureResult(pack, "retryable-failure", now(), results);
  }
  return failureResult(pack, "completed", now(), results);
}
