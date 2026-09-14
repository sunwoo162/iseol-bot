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

export type IseolRuntimeCapability = {
  state: "disabled" | "ready" | "blocked";
  enqueue?: (campaignId: string) => void;
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
    browserProfileRoot: resolve(configuredProfile || resolve(cwd, "data", "chatgpt-profile")),
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
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      if (firstError === undefined) firstError = error;
    }
  }
  if (!suppressErrors && firstError !== undefined) throw firstError;
}

export async function startIseolRuntimeServices(
  input: IseolRuntimeInput = {},
): Promise<IseolRuntimeServices> {
  const env = input.env ?? process.env;
  const deps = input.deps ?? {};
  const webConfig = input.webConfig ?? resolveWebControlPlaneConfig(env);
  const roots = input.roots ?? defaultRoots(env, webConfig);
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
    const needsBrowser = bridgeConfig.enabled || ideaLabConfig.enabled;
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

    const desktopAgentReady = ideaLabConfig.enabled && desktopCore?.transport && browser
      ? await waitForDesktopAgentConnection(desktopCore.transport, ideaLabConfig.agentId, agentReadyTimeoutMs, sleep)
      : false;
    if (ideaLabConfig.enabled && desktopCore?.transport && browser && desktopAgentReady) {
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
          superviseCampaign: async (campaignId) => {
            await superviseIdeaLabCampaign({
              root: roots.modelRoot,
              campaignId,
              proposalProvider,
              ...productionDriver,
            });
          },
        });
        await runtime.recover();
        capability = { state: "ready", enqueue: (campaignId) => runtime!.enqueue(campaignId) };
      }
    }

    webServer = await startWeb({ ...webConfig, ideaLabRuntime: capability });
  } catch (error) {
    await disposeOwnedResources({ webServer, bridge, runtime, desktopCore, browser }, true);
    throw error;
  }

  let disposed = false;
  return {
    webServer,
    desktopCore,
    ...(bridge ? { chatGptBridge: bridge } : {}),
    ...(runtime ? { ideaLabRuntime: runtime } : {}),
    ideaLabCapability: capability,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await disposeOwnedResources({ webServer, bridge, runtime, desktopCore, browser });
    },
  };
}
