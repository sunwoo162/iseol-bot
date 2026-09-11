import { resolve } from "node:path";
import { assertProjectModelId } from "../project-model/contracts.js";
import { archivePrototypeCandidate } from "../idea-lab/prototype-actions.js";
import { promotePrototype } from "../project-model/promotion.js";
import {
  cancelWebIdeaLabCampaign,
  createWebIdeaLabCampaign,
  WebIdeaLabActionError,
} from "./idea-lab-actions.js";
import {
  buildEvaluationView,
  buildIdeaLabView,
  buildProjectWorkspaceView,
} from "./view-model.js";

export type WebControlPlaneRequest = {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
};

export type WebControlPlaneResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export type IdeaLabRuntimeCapability = {
  state: "disabled" | "ready" | "blocked";
  enqueue?: (campaignId: string) => void;
};

export type WebControlPlaneRouterDependencies = {
  modelRoot: string;
  harnessRoot: string;
  evaluationRoot?: string;
  token?: string;
  now?: () => string;
  campaignIdFactory?: () => string;
  ideaLabRuntime?: IdeaLabRuntimeCapability;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function response(status: number, body: unknown): WebControlPlaneResponse {
  return { status, headers: JSON_HEADERS, body };
}
function decodeId(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes("/") || decoded.includes("\\")) return null;
    assertProjectModelId(decoded);
    return decoded;
  } catch {
    return null;
  }
}

function bearerToken(headers: Record<string, string | undefined>): string | null {
  const authorization = headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function mutationAuthorized(
  request: WebControlPlaneRequest,
  configuredToken: string | undefined,
): boolean {
  if (!configuredToken) return true;
  return bearerToken(request.headers) === configuredToken;
}

function methodNotAllowed(): WebControlPlaneResponse {
  return response(405, { error: "method not allowed" });
}
export async function routeWebControlPlaneRequest(
  request: WebControlPlaneRequest,
  deps: WebControlPlaneRouterDependencies,
): Promise<WebControlPlaneResponse> {
  const path = request.path.split("?", 1)[0] ?? request.path;

  if (path === "/api/evaluation") {
    if (request.method !== "GET") return methodNotAllowed();
    const configuredRoot = process.env.ISEOL_EVALUATION_ROOT?.trim();
    const evaluationRoot = deps.evaluationRoot
      ?? (configuredRoot ? resolve(configuredRoot) : resolve(process.cwd(), "data", "iseol-evaluation"));
    return response(200, await buildEvaluationView(evaluationRoot));
  }

  if (path === "/api/idea-lab") {
    if (request.method !== "GET") return methodNotAllowed();
    return response(200, await buildIdeaLabView(deps.modelRoot, deps.harnessRoot));
  }

  if (path === "/api/idea-lab/campaigns") {
    if (request.method !== "POST") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
    if (deps.ideaLabRuntime?.state === "blocked") return response(503, { error: "idea lab runtime unavailable" });
    try {
      const campaign = await createWebIdeaLabCampaign({
        root: deps.modelRoot, body: request.body ?? {},
        at: (deps.now ?? (() => new Date().toISOString()))(), idFactory: deps.campaignIdFactory,
      });
      if (deps.ideaLabRuntime?.state === "ready") deps.ideaLabRuntime.enqueue?.(campaign.id);
      return response(201, campaign);
    } catch (error) {
      if (error instanceof WebIdeaLabActionError) return response(error.status, { error: error.message });
      throw error;
    }
  }

  const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
  if (projectMatch) {
    if (request.method !== "GET") return methodNotAllowed();
    const projectId = decodeId(projectMatch[1] ?? "");
    if (!projectId) return response(404, { error: "not found" });
    const view = await buildProjectWorkspaceView(
      deps.modelRoot,
      deps.harnessRoot,
      projectId,
    );
    return view ? response(200, view) : response(404, { error: "not found" });
  }

  const cancelCampaignMatch = /^\/api\/idea-lab\/campaigns\/([^/]+)\/cancel$/.exec(path);
  if (cancelCampaignMatch) {
    if (request.method !== "POST") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
    const campaignId = decodeId(cancelCampaignMatch[1] ?? "");
    if (!campaignId) return response(404, { error: "not found" });
    try {
      return response(200, await cancelWebIdeaLabCampaign(
        deps.modelRoot, campaignId, (deps.now ?? (() => new Date().toISOString()))(),
      ));
    } catch (error) {
      if (error instanceof WebIdeaLabActionError) return response(error.status, { error: error.message });
      throw error;
    }
  }

  const archiveMatch = /^\/api\/prototypes\/([^/]+)\/archive$/.exec(path);
  if (archiveMatch) {
    if (request.method !== "POST") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
    const prototypeId = decodeId(archiveMatch[1] ?? "");
    if (!prototypeId) return response(404, { error: "not found" });
    try {
      return response(200, await archivePrototypeCandidate(
        deps.modelRoot, prototypeId, (deps.now ?? (() => new Date().toISOString()))(),
      ));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Prototype not found:")) return response(404, { error: "not found" });
      if (error instanceof Error && error.message.includes("cannot be archived")) return response(409, { error: error.message });
      throw error;
    }
  }

  const promotionMatch = /^\/api\/prototypes\/([^/]+)\/promote$/.exec(path);
  if (promotionMatch) {
    if (request.method !== "POST") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) {
      return response(401, { error: "unauthorized" });
    }
    const prototypeId = decodeId(promotionMatch[1] ?? "");
    if (!prototypeId) return response(404, { error: "not found" });

    try {
      const workspace = await promotePrototype({
        modelRoot: deps.modelRoot,
        harnessRoot: deps.harnessRoot,
        prototypeId,
        promotedAt: (deps.now ?? (() => new Date().toISOString()))(),
      });
      return response(200, workspace);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Prototype not found:")) {
        return response(404, { error: "not found" });
      }
      throw error;
    }
  }

  return response(404, { error: "not found" });
}
