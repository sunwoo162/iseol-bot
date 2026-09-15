import { basename, isAbsolute } from "node:path";

export type RunProcessPurpose = "test" | "build";

const SHELL_EXECUTABLES = new Set([
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "bash", "sh", "zsh",
]);
const PACKAGE_MANAGERS = new Set([
  "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd",
]);
const LOCATION_SWITCHES = new Set([
  "--prefix", "--global", "-g", "--cwd", "--dir", "--workspace-root", "--global-dir",
]);

function executableName(value: string): string {
  return basename(value).toLowerCase();
}

function assertSafeProcessArgs(args: string[]): void {
  for (const arg of args) {
    if (arg.includes("\0")) throw new Error("Desktop process argument contains NUL");
    if (isAbsolute(arg) || /^[A-Za-z]:[\\/]/.test(arg)) {
      throw new Error(`Desktop process absolute path argument is not allowed: ${arg}`);
    }
    if (arg.split(/[\\/]+/).includes("..")) {
      throw new Error(`Desktop process parent path argument is not allowed: ${arg}`);
    }
    if (LOCATION_SWITCHES.has(arg.toLowerCase())) {
      throw new Error(`Desktop process location switch is not allowed: ${arg}`);
    }
  }
}
function packageScriptAllowed(purpose: RunProcessPurpose, args: string[]): boolean {
  const expected = purpose;
  if (args[0]?.toLowerCase() === expected) return true;
  return args[0]?.toLowerCase() === "run" && args[1]?.toLowerCase() === expected;
}

function toolVerbAllowed(name: string, purpose: RunProcessPurpose, args: string[]): boolean {
  const first = args[0]?.toLowerCase() ?? "";
  if (PACKAGE_MANAGERS.has(name)) return packageScriptAllowed(purpose, args);
  if (name === "node" || name === "node.exe") {
    return purpose === "test" && first === "--test";
  }
  if (name === "dotnet" || name === "dotnet.exe") return first === purpose;
  if (["mvn", "mvn.cmd"].includes(name)) {
    const goals = new Set(args.filter((arg) => !arg.startsWith("-"))).keys();
    const values = [...goals];
    return purpose === "test" ? values.includes("test") : values.some((value) => value === "package" || value === "verify");
  }
  if (["gradle", "gradle.bat"].includes(name)) {
    const tasks = args.filter((arg) => !arg.startsWith("-")).map((arg) => arg.toLowerCase());
    return purpose === "test" ? tasks.includes("test") : tasks.some((task) => task === "build" || task === "assemble");
  }
  return false;
}

export function assertBoundedProcessRequest(
  purpose: RunProcessPurpose,
  executable: string,
  args: string[],
): void {
  const name = executableName(executable);
  if (SHELL_EXECUTABLES.has(name)) throw new Error(`Desktop shell executable is not allowed: ${executable}`);
  if (executable !== basename(executable)) throw new Error("Desktop process executable must be a bounded executable name");
  assertSafeProcessArgs(args);
  if ((name === "node" || name === "node.exe")
      && args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) {
    throw new Error("Desktop Node inline evaluation is not allowed");
  }
  if (!toolVerbAllowed(name, purpose, args)) {
    throw new Error(`Desktop ${purpose} process command is not allowed: ${name} ${args.join(" ")}`.trim());
  }
}
