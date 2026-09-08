const OPERATION_KEYS: Record<string, readonly string[]> = {
  READ_FILE: ["id", "type", "path"],
  LIST_DIRECTORY: ["id", "type", "path"],
  APPLY_PATCH: ["id", "type", "path", "patch"],
  RUN_PROCESS: ["id", "type", "cwd", "executable", "args", "timeoutMs"],
  GIT_STATUS: ["id", "type", "cwd"],
  GIT_DIFF: ["id", "type", "cwd"],
  GIT_BRANCH: ["id", "type", "cwd"],
  GIT_INSPECT: ["id", "type", "cwd"],
  GIT_WORKTREE_CREATE: ["id", "type", "cwd", "branch", "worktreePath", "baseRef"],
  GIT_COMMIT: ["id", "type", "cwd", "message", "expectedHead"],
  CHECK_HTTP: ["id", "type", "url", "timeoutMs"],
};

const UNSUPPORTED_GIT_PROCESS_COMMANDS = new Set([
  "reset", "clean", "checkout", "switch", "restore", "rm", "rebase",
  "merge", "cherry-pick", "revert", "commit", "push", "worktree", "tag",
]);

function executableName(value: string): string {
  return value.split(/[\\/]/).at(-1)?.toLowerCase() ?? value.toLowerCase();
}
export function assertDesktopOperationPolicy(operation: Record<string, unknown>): void {
  const type = String(operation.type);
  const allowedKeys = OPERATION_KEYS[type];
  if (!allowedKeys) return;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(operation).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Desktop ${type} operation has unknown field: ${unknown}`);

  if (type !== "RUN_PROCESS") return;
  if (typeof operation.executable !== "string" || !Array.isArray(operation.args)) return;
  const name = executableName(operation.executable);
  const firstArg = typeof operation.args[0] === "string" ? operation.args[0].toLowerCase() : "";
  if ((name === "git" || name === "git.exe") && UNSUPPORTED_GIT_PROCESS_COMMANDS.has(firstArg)) {
    throw new Error(`Desktop destructive Git process is not allowed: git ${firstArg}`);
  }
}
