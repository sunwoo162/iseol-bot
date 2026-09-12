import { isAbsolute, relative, resolve, sep } from "node:path";

type EnvLike = Record<string, string | undefined>;

export type IdeaLabRuntimeRoots = {
  iseolRoot: string;
  modelRoot: string;
  runRoot: string;
  webRoot: string;
  browserProfileRoot: string;
};

export type IdeaLabRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true;
      repositoryRoot: string;
      repositoryUrl: string;
      baseRef: string;
      sandboxRoot: string;
      agentId: string;
      testExecutable: string;
      testArgs: string[];
      testTimeoutMs: number;
    };

function strictBoolean(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return false;
  if (value === "false") return false;
  if (value === "true") return true;
  throw new Error("ISEOL_IDEA_LAB_RUNTIME_ENABLED must be true or false");
}

function required(env: EnvLike, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (!value) throw new Error(`${name} is required when Idea Lab runtime is enabled`);
  return value;
}

function insideOrEqual(root: string, target: string): boolean {
  const relation = relative(resolve(root), resolve(target));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

export function resolveIdeaLabRuntimeConfig(env: EnvLike, roots: IdeaLabRuntimeRoots): IdeaLabRuntimeConfig {
  if (!strictBoolean(env.ISEOL_IDEA_LAB_RUNTIME_ENABLED)) return { enabled: false };
  const repositoryRoot = resolve(required(env, "ISEOL_IDEA_LAB_REPOSITORY_ROOT"));
  const sandboxRoot = resolve(required(env, "ISEOL_IDEA_LAB_SANDBOX_ROOT"));
  const repositoryUrl = required(env, "ISEOL_IDEA_LAB_REPOSITORY_URL");
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+(?:\.git)?\/?$/.test(repositoryUrl)) {
    throw new Error("ISEOL_IDEA_LAB_REPOSITORY_URL must be a GitHub HTTPS repository URL");
  }
  if (!insideOrEqual(sandboxRoot, repositoryRoot)) throw new Error("repositoryRoot must be inside sandboxRoot");
  for (const [label, root] of Object.entries(roots)) {
    if (insideOrEqual(root, sandboxRoot)) throw new Error(`sandboxRoot must be outside ${label}`);
  }
  let testArgs: unknown;
  try { testArgs = JSON.parse(required(env, "ISEOL_IDEA_LAB_TEST_ARGS_JSON")); } catch { throw new Error("ISEOL_IDEA_LAB_TEST_ARGS_JSON must be valid JSON string array"); }
  if (!Array.isArray(testArgs) || testArgs.some((arg) => typeof arg !== "string")) throw new Error("ISEOL_IDEA_LAB_TEST_ARGS_JSON must be a string array");
  const timeoutText = env.ISEOL_IDEA_LAB_TEST_TIMEOUT_MS?.trim() || "120000";
  const testTimeoutMs = Number(timeoutText);
  if (!Number.isInteger(testTimeoutMs) || testTimeoutMs <= 0) throw new Error("ISEOL_IDEA_LAB_TEST_TIMEOUT_MS must be positive");
  return { enabled: true, repositoryRoot, repositoryUrl, baseRef: required(env, "ISEOL_IDEA_LAB_BASE_REF"), sandboxRoot, agentId: required(env, "ISEOL_IDEA_LAB_AGENT_ID"), testExecutable: required(env, "ISEOL_IDEA_LAB_TEST_EXECUTABLE"), testArgs, testTimeoutMs };
}
