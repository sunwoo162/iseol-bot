import { resolve } from "node:path";
import { assertProjectModelId } from "../project-model/contracts.js";
import { defaultAgentRoleRegistrations, resolveExecutionProfile } from "../project-model/execution-profile.js";
import { setProjectPurpose } from "../project-model/workspace-store.js";
import { prepareProjectWorkspaceRun, startProjectWorkspaceRun } from "../project-model/workspace-run-preparation.js";
import { buildPortfolioDraft, collectProjectEvidence, verifyPortfolioGrounding } from "../project-model/portfolio.js";
import { ensurePortfolioDocument, updatePortfolioDocument, verifyStoredPortfolioGrounding } from "../project-model/portfolio-store.js";
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
  retryRun?: (runId: string) => Promise<"accepted" | "already-active" | "not-allowed">;
};

export type WebControlPlaneRouterDependencies = {
  modelRoot: string;
  harnessRoot: string;
  iseolRoot?: string;
  policyRoot?: string;
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

  if (path === "/api/execution-profile") {
    if (request.method !== "POST") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
    const body = request.body;
    if (!body || typeof body !== "object") return response(400, { error: "purpose and objective are required" });
    const purpose = (body as Record<string, unknown>).purpose;
    const objective = (body as Record<string, unknown>).objective;
    if (typeof purpose !== "string" || typeof objective !== "string") {
      return response(400, { error: "purpose and objective are required" });
    }
    try {
      return response(200, resolveExecutionProfile({
        purpose: purpose as Parameters<typeof resolveExecutionProfile>[0]["purpose"],
        objective,
        roles: defaultAgentRoleRegistrations(),
      }));
    } catch {
      return response(400, { error: "invalid execution profile" });
    }
  }

  const portfolioMatch = /^\/api\/projects\/([^/]+)\/portfolio$/.exec(path);
  if (portfolioMatch) {
    const projectId = decodeId(portfolioMatch[1] ?? "");
    if (!projectId) return response(404, { error: "not found" });
    if (request.method === "PUT") {
      if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
      if (!request.body || typeof request.body !== "object") return response(400, { error: "invalid portfolio update" });
      try {
        return response(200, { document: await updatePortfolioDocument(deps.modelRoot, projectId, request.body as { sections?: Array<{ id: string; content: string; included: boolean }>; readme?: string }, (deps.now ?? (() => new Date().toISOString()))()) });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("Portfolio document not found:")) return response(404, { error: "not found" });
        if (error instanceof Error && /Invalid portfolio/.test(error.message)) return response(400, { error: "invalid portfolio update" });
        throw error;
      }
    }
    if (request.method !== "GET") return methodNotAllowed();
    try {
      const evidence = await collectProjectEvidence(deps.modelRoot, deps.harnessRoot, projectId);
      const draft = buildPortfolioDraft(evidence, (deps.now ?? (() => new Date().toISOString()))());
      const document = await ensurePortfolioDocument(deps.modelRoot, draft, (deps.now ?? (() => new Date().toISOString()))());
      const generatedGrounding = verifyPortfolioGrounding(draft, evidence);
      const documentGrounding = verifyStoredPortfolioGrounding(document, new Set(evidence.evidence.map((item) => item.id)));
      return response(200, { draft, document, evidence: evidence.evidence, grounding: { ...generatedGrounding, documentGrounded: documentGrounding.grounded, needsReview: documentGrounding.needsReview } });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Project workspace not found:")) return response(404, { error: "not found" });
      throw error;
    }
  }

  const purposeMatch = /^\/api\/projects\/([^/]+)\/purpose$/.exec(path);
  if (purposeMatch) {
    if (request.method !== "PUT") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
    const projectId = decodeId(purposeMatch[1] ?? "");
    if (!projectId || !request.body || typeof request.body !== "object") return response(400, { error: "invalid project purpose" });
    const body = request.body as Record<string, unknown>;
    if (typeof body.purpose !== "string" || typeof body.objective !== "string") return response(400, { error: "purpose and objective are required" });
    try {
      const profile = resolveExecutionProfile({
        purpose: body.purpose as Parameters<typeof resolveExecutionProfile>[0]["purpose"],
        objective: body.objective,
        roles: defaultAgentRoleRegistrations(),
      });
      const selectedAt = (deps.now ?? (() => new Date().toISOString()))();
      await setProjectPurpose(deps.modelRoot, projectId, profile, selectedAt, "user");
      const view = await buildProjectWorkspaceView(deps.modelRoot, deps.harnessRoot, projectId);
      return view ? response(200, view) : response(404, { error: "not found" });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Project workspace not found:")) return response(404, { error: "not found" });
      if (error instanceof Error && /purpose|objective|Unsupported/.test(error.message)) return response(400, { error: "invalid project purpose" });
      throw error;
    }
  }

  const preparationMatch = /^\/api\/projects\/([^/]+)\/execution-preparation$/.exec(path);
  if (preparationMatch) {
    if (request.method !== "POST") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
    const projectId = decodeId(preparationMatch[1] ?? "");
    if (!projectId || !request.body || typeof request.body !== "object") return response(400, { error: "invalid execution preparation" });
    const body = request.body as Record<string, unknown>;
    if (typeof body.runId !== "string" || typeof body.objective !== "string" || typeof body.targetRoot !== "string") {
      return response(400, { error: "runId, objective and targetRoot are required" });
    }
    try {
      return response(200, await prepareProjectWorkspaceRun(deps.modelRoot, projectId, {
        runId: body.runId,
        objective: body.objective,
        targetRoot: body.targetRoot,
      }));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Project workspace not found:")) return response(404, { error: "not found" });
      if (error instanceof Error && error.message.includes("purpose must be selected")) return response(409, { error: "project purpose must be selected" });
      throw error;
    }
  }

  const startMatch = /^\/api\/projects\/([^/]+)\/execution-start$/.exec(path);
  if (startMatch) {
    if (request.method !== "POST") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
    const projectId = decodeId(startMatch[1] ?? "");
    if (!projectId || !request.body || typeof request.body !== "object") return response(400, { error: "invalid execution start" });
    const body = request.body as Record<string, unknown>;
    if (typeof body.runId !== "string" || typeof body.objective !== "string" || typeof body.targetRoot !== "string") {
      return response(400, { error: "runId, objective and targetRoot are required" });
    }
    try {
      const started = await startProjectWorkspaceRun(deps.modelRoot, projectId, {
        runId: body.runId,
        objective: body.objective,
        targetRoot: body.targetRoot,
      }, {
        iseolRoot: deps.iseolRoot ?? deps.modelRoot,
        storeRoot: deps.harnessRoot,
        ...(deps.policyRoot ? { policyRoot: deps.policyRoot } : {}),
        loadedAt: (deps.now ?? (() => new Date().toISOString()))(),
      });
      return response(started.status === "created" ? 201 : 200, started);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Project workspace not found:")) return response(404, { error: "not found" });
      if (error instanceof Error && /purpose|root node|terminal|identity|request does not match/.test(error.message)) return response(409, { error: error.message });
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

  const retryRunMatch = /^\/api\/idea-lab\/runs\/([^/]+)\/retry$/.exec(path);
  if (retryRunMatch) {
    if (request.method !== "POST") return methodNotAllowed();
    if (!mutationAuthorized(request, deps.token)) return response(401, { error: "unauthorized" });
    const runId = decodeId(retryRunMatch[1] ?? "");
    if (!runId) return response(404, { error: "not found" });
    if (deps.ideaLabRuntime?.state !== "ready" || !deps.ideaLabRuntime.retryRun) return response(503, { error: "idea lab runtime unavailable" });
    const result = await deps.ideaLabRuntime.retryRun(runId);
    if (result === "not-allowed") return response(409, { status: result, error: "Run is not terminal FAILED_FINAL or cannot be retried" });
    return response(202, { status: result, runId });
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
