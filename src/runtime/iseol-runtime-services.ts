import { resolve } from "node:path";
import type { Server } from "node:http";
import {
  resolveWebControlPlaneConfig,
  startWebControlPlaneServer,
  type WebControlPlaneConfig,
} from "../web-control-plane/server.js";
import {
  resolveDesktopAgentCoreConfig,
  startDesktopAgentCoreService,
  type DesktopAgentCoreConfig,
} from "../desktop-agent/core-service.js";
import { refreshDevelopmentRunPreflight } from "../harness/run-service.js";
import { listHarnessRuns, loadHarnessRun, requestHarnessRunRetry } from "../harness/run-store.js";
import { listDesktopJobs } from "../desktop-agent/job-store.js";
import { inspectProjectRunReconciliation, reconcileProjectRunAsOperator, type ProjectRunReconciliationInput, type ProjectRunReconciliationResult } from "../harness/operator-reconciliation.js";
import { getActiveWebWorkerSession } from "../chatgpt-web/session-store.js";
import { superviseHarnessRun } from "../harness/run-supervisor.js";
import {
  resolveProductionChatGptBrowserDriver,
  resolveChatGptWebBridgeConfig,
  startChatGptWebBridgeService,
  type ChatGptWebBridgeService,
} from "../chatgpt-web/browser-service.js";
import {
  createProductionChatGptWebAdapter,
  type ChatGptBrowserDriver,
} from "../chatgpt-web/production-browser-adapter.js";
import { createChatGptIdeaProposalProvider } from "../idea-lab/chatgpt-proposal-provider.js";
import {
  resolveIdeaLabRuntimeConfig,
  type IdeaLabRuntimeConfig,
  type IdeaLabRuntimeRoots,
} from "../idea-lab/runtime-config.js";
import { createIdeaLabProductionDesktopTaskCompiler } from "../idea-lab/production-desktop-compiler.js";
import { createIdeaLabProductionRuntimeDriver } from "../idea-lab/production-runtime-driver.js";
import { listPrototypeProductions } from "../idea-lab/production-store.js";
import {
  createIdeaLabRuntimeService,
  type IdeaLabRuntimeService,
} from "../idea-lab/runtime-service.js";
import { superviseIdeaLabCampaign } from "../idea-lab/campaign-supervisor.js";
import {
  createDesktopPrototypeSandboxAdapter,
  type PrototypeSandboxAdapter,
} from "../idea-lab/sandbox-adapter.js";
import {
  resolveVercelPrototypeDeployAdapter,
} from "../idea-lab/vercel-deploy-adapter.js";
import type { PrototypeDeployAdapter } from "../idea-lab/deploy-adapter.js";
import { createProjectWorkspaceExecutor } from "./project-workspace-executor.js";
import { createProjectWorkspaceDesktopTaskCompiler } from "./project-workspace-desktop-compiler.js";

export type IseolRuntimeCapability = {
  state: "disabled" | "ready" | "blocked";
  enqueue?: (campaignId: string) => void;
  retryRun?: (runId: string) => Promise<"accepted" | "already-active" | "not-allowed">;
  enqueueProjectRun?: (runId: string) => Promise<"accepted" | "already-active" | "not-configured">;
  inspectProjectRunReconciliation?: (input: { projectId: string; runId: string; expectedRevision: string }) => Promise<Awaited<ReturnType<typeof inspectProjectRunReconciliation>>>;
  reconcileProjectRun?: (input: Omit<ProjectRunReconciliationInput, "storeRoot" | "observe">) => Promise<ProjectRunReconciliationResult>;
};
type DesktopCoreService = Awaited<ReturnType<typeof startDesktopAgentCoreService>>;
type ProductionDriver = ReturnType<typeof createIdeaLabProductionRuntimeDriver>;

type RuntimeDependencies = {
  startDesktop?: typeof startDesktopAgentCoreService;
  startWeb?: typeof startWebControlPlaneServer;
  resolveBrowser?: typeof resolveProductionChatGptBrowserDriver;
  createBridge?: typeof startChatGptWebBridgeService;
  resolveDeploy?: (env: Record<string, string | undefined>) => PrototypeDeployAdapter | null | Promise<PrototypeDeployAdapter | null>;
  createProposalProvider?: typeof createChatGptIdeaProposalProvider;
  createProductionDriver?: typeof createIdeaLabProductionRuntimeDriver;
  createRuntime?: typeof createIdeaLabRuntimeService;
  createSandboxAdapter?: typeof createDesktopPrototypeSandboxAdapter;
  createProjectExecutor?: typeof createProjectWorkspaceExecutor;
  sleep?: (ms: number) => Promise<void>;
};

export type IseolRuntimeInput = {
  env?: Record<string, string | undefined>;
  roots?: IdeaLabRuntimeRoots;
  webConfig?: WebControlPlaneConfig;
  desktopConfig?: DesktopAgentCoreConfig;
  ideaLabConfig?: IdeaLabRuntimeConfig;
  agentReadyTimeoutMs?: number;
  deps?: RuntimeDependencies;
};

export type IseolRuntimeServices = {
  webServer: Server;
  desktopCore: DesktopCoreService | null;
  chatGptBridge?: ChatGptWebBridgeService;
  ideaLabRuntime?: IdeaLabRuntimeService;
  ideaLabCapability: IseolRuntimeCapability;
  dispose(): Promise<void>;
};

function projectRuntimeRequested(env: Record<string, string | undefined>): boolean {
  return env.ISEOL_PROJECT_RUNTIME_ENABLED?.trim().toLowerCase() === "true";
}

function projectAgentId(env: Record<string, string | undefined>, ideaLabConfig: IdeaLabRuntimeConfig): string | null {
  const explicit = env.ISEOL_PROJECT_AGENT_ID?.trim();
  if (explicit) return explicit;
  return ideaLabConfig.enabled ? ideaLabConfig.agentId : null;
}

export function shouldAutoRecoverProjectRun(status: string): boolean {
  void status;
  return false;
}

export function hasProjectRuntimeOwner(
  runs: ReadonlyArray<{ request: { mode: string; runId: string }; state: { status: string } }>,
  runId: string,
): boolean {
  return runs.some((candidate) =>
    candidate.request.mode === "project-workspace"
    && candidate.request.runId !== runId
    && candidate.state.status === "RUNNING",
  );
}

function projectTestConfig(env: Record<string, string | undefined>) {
  const executable = env.ISEOL_PROJECT_TEST_EXECUTABLE?.trim() || (process.platform === "win32" ? "npm.cmd" : "npm");
  let args = ["test"];
  const encoded = env.ISEOL_PROJECT_TEST_ARGS_JSON?.trim();
  if (encoded) {
    try {
      const parsed = JSON.parse(encoded);
      if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("invalid");
      args = parsed;
    } catch { throw new Error("ISEOL_PROJECT_TEST_ARGS_JSON must be a string array"); }
  }
  const timeoutMs = Number(env.ISEOL_PROJECT_TEST_TIMEOUT_MS?.trim() || "120000");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("ISEOL_PROJECT_TEST_TIMEOUT_MS must be positive");
  return { executable, args, timeoutMs };
}
function defaultRoots(
  env: Record<string, string | undefined>,
  webConfig: WebControlPlaneConfig,
): IdeaLabRuntimeRoots {
  const cwd = process.cwd();
  const configuredProfile = env.ISEOL_CHATGPT_BROWSER_PROFILE_ROOT?.trim();
  return {
    iseolRoot: cwd,
    modelRoot: resolve(webConfig.modelRoot),
    runRoot: resolve(webConfig.harnessRoot),
    webRoot: resolve(webConfig.webRoot),
    webWorkerRoot: resolve(resolveChatGptWebBridgeConfig(env).workerRoot),
    browserProfileRoot: resolve(configuredProfile || resolve(cwd, "data", "chatgpt-profile")),
    ...(env.ISEOL_PROJECT_MODEL_ROOT?.trim() ? { projectModelRoot: resolve(env.ISEOL_PROJECT_MODEL_ROOT) } : {}),
    ...(env.ISEOL_PROJECT_RUN_ROOT?.trim() ? { projectRunRoot: resolve(env.ISEOL_PROJECT_RUN_ROOT) } : {}),
    ...(env.ISEOL_PROJECT_WEB_WORKER_ROOT?.trim() ? { projectWebWorkerRoot: resolve(env.ISEOL_PROJECT_WEB_WORKER_ROOT) } : {}),
    ...(env.ISEOL_PROJECT_DESKTOP_STATE_ROOT?.trim() ? { projectDesktopStateRoot: resolve(env.ISEOL_PROJECT_DESKTOP_STATE_ROOT) } : {}),
  };
}

async function resolveSharedBrowser(
  env: Record<string, string | undefined>,
  roots: IdeaLabRuntimeRoots,
  repositoryRoot: string,
  chatGptWebRoot: string,
  resolver: typeof resolveProductionChatGptBrowserDriver,
): Promise<ChatGptBrowserDriver | null> {
  return resolver(env, {
    repositoryRoot,
    modelRoot: roots.modelRoot,
    runRoot: roots.runRoot,
    webRoot: roots.webRoot,
    chatGptWebRoot: resolve(chatGptWebRoot),
  });
}

async function waitForDesktopAgentConnection(
  transport: { isAgentConnected(agentId: string): boolean },
  agentId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (transport.isAgentConnected(agentId)) return true;
  if (timeoutMs === 0) return false;
  const pollMs = 50;
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += pollMs) {
    await sleep(Math.min(pollMs, timeoutMs - elapsed));
    if (transport.isAgentConnected(agentId)) return true;
  }
  return false;
}

async function closeWebServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

type OwnedResources = {
  webServer?: Server;
  bridge?: ChatGptWebBridgeService;
  runtime?: IdeaLabRuntimeService;
  desktopCore?: DesktopCoreService | null;
  browser?: ChatGptBrowserDriver | null;
};

async function disposeOwnedResources(resources: OwnedResources, suppressErrors = false): Promise<void> {
  let firstError: unknown;
  const actions: Array<() => Promise<void>> = [
    async () => closeWebServer(resources.webServer),
    async () => { if (resources.bridge?.enabled) await resources.bridge.dispose(); },
    async () => { await resources.runtime?.dispose(); },
    async () => { await resources.desktopCore?.close(); },
    async () => { await resources.browser?.dispose?.(); },
  ];
  const executions = actions.map(async (action) => {
    try {
      await action();
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error };
    }
  });
  for (const execution of executions) {
    const result = await execution;
    if (!result.ok && firstError === undefined) firstError = result.error;
  }
  if (!suppressErrors && firstError !== undefined) throw firstError;
}

export async function startIseolRuntimeServices(
  input: IseolRuntimeInput = {},
): Promise<IseolRuntimeServices> {
  const env = input.env ?? process.env;
  const deps = input.deps ?? {};
  const webConfig = input.webConfig ?? resolveWebControlPlaneConfig(env);
  const roots = input.roots
    ? {
        ...input.roots,
        ...(input.roots.projectModelRoot ? { projectModelRoot: resolve(input.roots.projectModelRoot) } : {}),
        ...(input.roots.projectRunRoot ? { projectRunRoot: resolve(input.roots.projectRunRoot) } : {}),
        ...(input.roots.projectWebWorkerRoot ? { projectWebWorkerRoot: resolve(input.roots.projectWebWorkerRoot) } : {}),
        ...(input.roots.projectDesktopStateRoot ? { projectDesktopStateRoot: resolve(input.roots.projectDesktopStateRoot) } : {}),
        webWorkerRoot: input.roots.webWorkerRoot ?? resolve(resolveChatGptWebBridgeConfig(env).workerRoot),
      }
    : defaultRoots(env, webConfig);
  const requestedFlag = env.ISEOL_IDEA_LAB_RUNTIME_ENABLED?.trim().toLowerCase() === "true";
  let ideaLabConfig: IdeaLabRuntimeConfig;
  let ideaLabConfigBlocked = false;
  try {
    ideaLabConfig = input.ideaLabConfig ?? resolveIdeaLabRuntimeConfig(env, roots);
  } catch (error) {
    if (!requestedFlag) throw error;
    ideaLabConfig = { enabled: false };
    ideaLabConfigBlocked = true;
  }
  const ideaLabRequested = ideaLabConfig.enabled || ideaLabConfigBlocked;
  let desktopConfig: DesktopAgentCoreConfig;
  try {
    desktopConfig = input.desktopConfig ?? resolveDesktopAgentCoreConfig(env);
  } catch (error) {
    if (!ideaLabRequested) throw error;
    desktopConfig = {
      enabled: false,
      host: "127.0.0.1",
      port: 8791,
      stateRoot: resolve(roots.iseolRoot, "data", "desktop-agent"),
    };
  }
  const bridgeConfig = resolveChatGptWebBridgeConfig(env);
  const startDesktop = deps.startDesktop ?? startDesktopAgentCoreService;
  const startWeb = deps.startWeb ?? startWebControlPlaneServer;
  const resolveBrowser = deps.resolveBrowser ?? resolveProductionChatGptBrowserDriver;
  const createBridge = deps.createBridge ?? startChatGptWebBridgeService;
  const resolveDeploy = deps.resolveDeploy ?? resolveVercelPrototypeDeployAdapter;
  const createProposalProvider = deps.createProposalProvider ?? createChatGptIdeaProposalProvider;
  const createProductionDriver = deps.createProductionDriver ?? createIdeaLabProductionRuntimeDriver;
  const createRuntime = deps.createRuntime ?? createIdeaLabRuntimeService;
  const createSandboxAdapter = deps.createSandboxAdapter ?? createDesktopPrototypeSandboxAdapter;
  const createProjectExecutor = deps.createProjectExecutor ?? createProjectWorkspaceExecutor;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms)));
  const agentReadyTimeoutMs = input.agentReadyTimeoutMs ?? 31_000;
  if (!Number.isInteger(agentReadyTimeoutMs) || agentReadyTimeoutMs < 0) {
    throw new Error("agentReadyTimeoutMs must be a non-negative integer");
  }

  let desktopCore: DesktopCoreService | null = null;
  let browser: ChatGptBrowserDriver | null = null;
  let bridge: ChatGptWebBridgeService | undefined;
  let runtime: IdeaLabRuntimeService | undefined;
  let webServer: Server | undefined;
  let unsubscribeAgentConnected: (() => void) | undefined;
  const projectActiveRuns = new Map<string, Promise<void>>();
  let enqueueProjectRun: IseolRuntimeCapability["enqueueProjectRun"];
  let inspectProjectRun: IseolRuntimeCapability["inspectProjectRunReconciliation"];
  let reconcileProjectRun: IseolRuntimeCapability["reconcileProjectRun"];
  let capability: IseolRuntimeCapability = ideaLabRequested
    ? { state: "blocked" }
    : { state: "disabled" };

  try {
    if (desktopConfig.enabled) {
      try {
        desktopCore = await startDesktop(desktopConfig);
      } catch (error) {
        if (!ideaLabRequested) throw error;
        desktopCore = null;
      }
    }
    const projectFlag = projectRuntimeRequested(env);
    const projectRootsConfigured = Boolean(roots.projectModelRoot && roots.projectRunRoot && roots.projectWebWorkerRoot && roots.projectDesktopStateRoot);
    const projectRequested = projectFlag && projectRootsConfigured;
    const projectConfigBlocked = projectFlag && !projectRootsConfigured;
    if (projectConfigBlocked && !ideaLabRequested) capability = { state: "blocked" };
    const needsBrowser = bridgeConfig.enabled || ideaLabConfig.enabled || projectRequested;
    const browserRepositoryRoot = ideaLabConfig.enabled
      ? ideaLabConfig.repositoryRoot
      : roots.iseolRoot;
    if (needsBrowser) {
      try {
        browser = await resolveSharedBrowser(env, roots, browserRepositoryRoot, bridgeConfig.workerRoot, resolveBrowser);
      } catch (error) {
        if (!ideaLabRequested) throw error;
        browser = null;
      }
    }

    bridge = bridgeConfig.enabled && browser
      ? await createBridge(bridgeConfig, browser, { ownsDriver: false })
      : undefined;

    const configuredProjectAgentId = projectAgentId(env, ideaLabConfig);
    const runtimeAgentId = ideaLabConfig.enabled ? ideaLabConfig.agentId : configuredProjectAgentId;
    const desktopAgentReady = runtimeAgentId && desktopCore?.transport && browser
      ? await waitForDesktopAgentConnection(desktopCore.transport, runtimeAgentId, agentReadyTimeoutMs, sleep)
      : false;
    if ((ideaLabConfig.enabled || projectRequested) && desktopCore?.transport && browser && desktopAgentReady) {
      if (ideaLabConfig.enabled) {
      let deployAdapter: PrototypeDeployAdapter | null = null;
      try {
        deployAdapter = await resolveDeploy(env);
      } catch {
        deployAdapter = null;
      }
      if (deployAdapter) {
        const sandboxAdapter: PrototypeSandboxAdapter = createSandboxAdapter({
          dispatch: async (pack) => {
            desktopCore!.transport.sendTask(pack.agentId, pack);
            return desktopCore!.transport.awaitResult(pack.jobId, 120_000);
          },
          refreshPreflight: refreshDevelopmentRunPreflight,
        });
        const proposalProvider = createProposalProvider(browser);
        const productionDriver: ProductionDriver = createProductionDriver({
          ...ideaLabConfig,
          roots,
          sandboxAdapter,
          desktopTransport: desktopCore.transport,
          browserAdapter: createProductionChatGptWebAdapter(browser),
          desktopTaskCompiler: createIdeaLabProductionDesktopTaskCompiler(ideaLabConfig),
          desktopStateRoot: desktopConfig.stateRoot,
          deployAdapter,
        });
        runtime = createRuntime({
          modelRoot: roots.modelRoot,
          requestRetry: async (runId) => {
            const production = (await listPrototypeProductions(roots.modelRoot)).find((item) => item.runId === runId);
            if (!production) return "not-allowed";
            const result = await requestHarnessRunRetry(roots.runRoot, runId, {
              retryReason: "operator-request",
              actor: "operator",
              requestedAt: new Date().toISOString(),
            });
            if (result.status === "accepted") runtime?.enqueue(production.campaignId);
            return result.status;
          },
          superviseCampaign: async (campaignId) => {
            await superviseIdeaLabCampaign({
              root: roots.modelRoot,
              harnessRoot: roots.runRoot,
              campaignId,
              proposalProvider,
              ...productionDriver,
            });
          },
        });
        const liveRuntime = runtime;

        unsubscribeAgentConnected = desktopCore.transport.onAgentConnected?.(
          (agentId: string) => {
            if (agentId !== ideaLabConfig.agentId) return;

            void liveRuntime.recover().catch(() => undefined);
          },
        );

        await runtime.recover();
        capability = {
          state: "ready",
          enqueue: (campaignId) => runtime!.enqueue(campaignId),
          retryRun: (runId) => runtime!.retryRun(runId),
        };
      }

      }
      if (projectRequested && desktopCore?.transport && browser && configuredProjectAgentId && desktopAgentReady) {
        const projectAgentReady = configuredProjectAgentId === runtimeAgentId
          ? true
          : await waitForDesktopAgentConnection(desktopCore.transport, configuredProjectAgentId, agentReadyTimeoutMs, sleep);
        if (!projectAgentReady) {
          // Keep the Web control plane available; the Project Run will be reported as not configured
          // until the explicitly configured Agent is connected.
        } else {
        const browserAdapter = bridge?.enabled
          ? bridge.adapter
          : createProductionChatGptWebAdapter(browser);
        const compilerConfig = projectTestConfig(env);
        const projectExecutor = createProjectExecutor({
          runRoot: roots.projectRunRoot!,
          workerRoot: roots.projectWebWorkerRoot!,
          registryRoot: desktopConfig.stateRoot,
          desktopStateRoot: roots.projectDesktopStateRoot!,
          desktopTransport: desktopCore.transport,
          browserAdapter,
          agentId: configuredProjectAgentId,
          desktopTaskCompiler: createProjectWorkspaceDesktopTaskCompiler({
            testExecutable: compilerConfig.executable,
            testArgs: compilerConfig.args,
            testTimeoutMs: compilerConfig.timeoutMs,
          }),
        });
        enqueueProjectRun = async (runId: string) => {
          const existing = projectActiveRuns.get(runId);
          if (existing) return "already-active";
          const run = await loadHarnessRun(roots.projectRunRoot!, runId);
          if (!run || run.request.mode !== "project-workspace") return "not-configured";
          if (!["READY", "RUNNING", "FAILED_RETRYABLE"].includes(run.state.status)) return "not-configured";
          if (hasProjectRuntimeOwner(await listHarnessRuns(roots.projectRunRoot!), runId)) return "already-active";
          const operation = superviseHarnessRun({ storeRoot: roots.projectRunRoot!, runId, executor: projectExecutor, maxSteps: 16 });
          const tracked = operation.then(() => undefined).finally(() => {
            if (projectActiveRuns.get(runId) === tracked) projectActiveRuns.delete(runId);
          });
          projectActiveRuns.set(runId, tracked);
          void tracked.catch(() => undefined);
          return "accepted";
        };
        const observeProjectRun = async (runId: string) => {
          const jobs = (await listDesktopJobs(roots.projectDesktopStateRoot!)).filter((job) => job.runId === runId);
          const persistedRun = await loadHarnessRun(roots.projectRunRoot!, runId);
          const session = persistedRun
            ? await getActiveWebWorkerSession(roots.projectWebWorkerRoot!, runId, persistedRun.state.stage).catch(() => null)
            : null;
          const active = projectActiveRuns.has(runId);
          const workerOwned = active || session?.status === "starting" || session?.status === "busy";
          return {
            activeRuntimeOwner: active,
            activeWorker: workerOwned,
            ...(workerOwned ? { browserSessionOwner: runId } : {}),
            desktopJobs: jobs,
            completedResultsReconciled: true,
          };
        };
        inspectProjectRun = async ({ projectId, runId, expectedRevision }) => inspectProjectRunReconciliation({
          storeRoot: roots.projectRunRoot!, projectId, runId, expectedRevision,
          observe: () => observeProjectRun(runId),
        });
        reconcileProjectRun = async (input) => reconcileProjectRunAsOperator({
          ...input,
          storeRoot: roots.projectRunRoot!,
          observe: () => observeProjectRun(input.runId),
        });
        for (const run of await listHarnessRuns(roots.projectRunRoot!)) {
          if (run.request.mode === "project-workspace" && shouldAutoRecoverProjectRun(run.state.status)) {
            void enqueueProjectRun(run.request.runId);
          }
        }
        }
      }
    }

    webServer = await startWeb({
      ...webConfig,
      // Harness preflight resolves the global policy relative to iseolRoot.
      // Live Idea Lab and Project Workspace runs share the repository policy,
      // while their durable model/run roots remain isolated above.
      iseolRoot: ideaLabConfig.enabled ? ideaLabConfig.repositoryRoot : roots.iseolRoot,
      policyRoot: ideaLabConfig.enabled ? ideaLabConfig.repositoryRoot : roots.iseolRoot,
      ...(roots.projectModelRoot ? { projectModelRoot: roots.projectModelRoot } : {}),
      ...(roots.projectRunRoot ? { projectHarnessRoot: roots.projectRunRoot } : {}),
      ideaLabRuntime: {
        ...capability,
        ...(enqueueProjectRun ? { enqueueProjectRun } : {}),
        ...(inspectProjectRun ? { inspectProjectRunReconciliation: inspectProjectRun } : {}),
        ...(reconcileProjectRun ? { reconcileProjectRun } : {}),
      },
    });
  } catch (error) {
    unsubscribeAgentConnected?.();
    unsubscribeAgentConnected = undefined;
    await disposeOwnedResources({ webServer, bridge, runtime, desktopCore, browser }, true);
    throw error;
  }

  let disposed = false;
  return {
    webServer,
    desktopCore,
    ...(bridge ? { chatGptBridge: bridge } : {}),
    ...(runtime ? { ideaLabRuntime: runtime } : {}),
    ideaLabCapability: {
      ...capability,
      ...(enqueueProjectRun ? { enqueueProjectRun } : {}),
      ...(inspectProjectRun ? { inspectProjectRunReconciliation: inspectProjectRun } : {}),
      ...(reconcileProjectRun ? { reconcileProjectRun } : {}),
    },
    async dispose() {
      if (disposed) return;

      unsubscribeAgentConnected?.();
      unsubscribeAgentConnected = undefined;
      disposed = true;
      await disposeOwnedResources({ webServer, bridge, runtime, desktopCore, browser });
    },
  };
}
