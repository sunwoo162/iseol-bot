import type { MemoryService } from "../memory/contracts.js";
import type { PlatformUserService } from "../platform-user/contracts.js";
import type { PersonalWorldService } from "./contracts.js";
import type { UserRequest, UserResponse } from "../web-control-plane/user-router.js";

export type PersonalWorldRouteServices = {
  platformUserService: PlatformUserService;
  personalWorldService?: PersonalWorldService;
  memoryService?: MemoryService;
};

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

function response(status: number, body: unknown): UserResponse {
  return { status, headers: JSON_HEADERS, body };
}

function bearer(headers: Record<string, string | undefined>): string | null {
  const value = headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

async function authenticated(request: UserRequest, services: PersonalWorldRouteServices) {
  const token = bearer(request.headers);
  if (!token) return null;
  return services.platformUserService.resolveAuthenticatedPrincipal(token);
}

function objectBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

export async function routePersonalWorldRequest(request: UserRequest, services: PersonalWorldRouteServices): Promise<UserResponse> {
  const url = new URL(request.path, "http://iseol.local");
  const principal = await authenticated(request, services);
  if (!principal) return response(401, { error: "authentication required" });

  if (url.pathname === "/api/user/world") {
    if (!services.personalWorldService) return response(503, { error: "personal world unavailable" });
    if (request.method === "GET") {
      const world = await services.personalWorldService.getWorld(principal);
      const character = await services.personalWorldService.getCharacter(principal);
      return response(200, { world, character });
    }
    if (request.method === "PUT" || request.method === "PATCH") {
      const body = objectBody(request.body);
      if (!body) return response(400, { error: "json object body required" });
      const world = await services.personalWorldService.updateWorld(principal, body);
      const character = await services.personalWorldService.getCharacter(principal);
      return response(200, { world, character });
    }
    return response(405, { error: "method not allowed" });
  }

  if (url.pathname === "/api/user/character") {
    if (!services.personalWorldService) return response(503, { error: "personal world unavailable" });
    if (request.method !== "PATCH" && request.method !== "PUT") return response(405, { error: "method not allowed" });
    const body = objectBody(request.body);
    if (!body) return response(400, { error: "json object body required" });
    const character = await services.personalWorldService.updateCharacter(principal, body);
    return response(200, { character });
  }

  if (url.pathname === "/api/user/memory") {
    if (!services.memoryService) return response(503, { error: "private memory unavailable" });
    if (request.method === "GET") {
      const memories = await services.memoryService.listPrivateMemories(principal, {
        ...(url.searchParams.get("search") ? { search: url.searchParams.get("search")! } : {}),
        ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
      });
      return response(200, { memories });
    }
    if (request.method === "POST") {
      const body = objectBody(request.body);
      if (!body || typeof body.kind !== "string" || typeof body.content !== "string") return response(400, { error: "kind and content are required" });
      const memory = await services.memoryService.appendPrivateMemory(principal, {
        kind: body.kind,
        content: body.content,
        ...(typeof body.source === "string" ? { source: body.source } : {}),
      });
      return response(201, { memory });
    }
    return response(405, { error: "method not allowed" });
  }

  if (url.pathname === "/api/user/memory/shared") {
    if (!services.memoryService) return response(503, { error: "private memory unavailable" });
    if (request.method !== "GET") return response(405, { error: "method not allowed" });
    const teamId = url.searchParams.get("teamId");
    if (!teamId) return response(400, { error: "teamId is required" });
    return response(200, { memories: await services.memoryService.listSharedMemories(principal, teamId) });
  }

  const memoryPrefix = "/api/user/memory/";
  if (url.pathname.startsWith(memoryPrefix)) {
    if (!services.memoryService) return response(503, { error: "private memory unavailable" });
    const memoryId = decodeURIComponent(url.pathname.slice(memoryPrefix.length));
    if (!memoryId) return response(404, { error: "not found" });
    if (url.pathname.endsWith("/sharing")) {
      const id = decodeURIComponent(url.pathname.slice(memoryPrefix.length, -"/sharing".length));
      if (!id) return response(404, { error: "memory not found" });
      if (request.method !== "PATCH" && request.method !== "PUT") return response(405, { error: "method not allowed" });
      const body = objectBody(request.body);
      if (!body || !Array.isArray(body.teamIds) || body.teamIds.some((teamId) => typeof teamId !== "string")) return response(400, { error: "teamIds must be an array of strings" });
      const memory = await services.memoryService.updatePrivateMemorySharing(principal, id, body.teamIds as string[]);
      return memory ? response(200, { memory }) : response(404, { error: "memory not found" });
    }
    if (request.method === "PATCH" || request.method === "PUT") {
      const body = objectBody(request.body);
      if (!body) return response(400, { error: "json object body required" });
      if (body.kind !== undefined && typeof body.kind !== "string") return response(400, { error: "kind must be a string" });
      if (body.content !== undefined && typeof body.content !== "string") return response(400, { error: "content must be a string" });
      if (body.source !== undefined && body.source !== null && typeof body.source !== "string") return response(400, { error: "source must be a string or null" });
      const memory = await services.memoryService.updatePrivateMemory(principal, memoryId, {
        ...(typeof body.kind === "string" ? { kind: body.kind } : {}),
        ...(typeof body.content === "string" ? { content: body.content } : {}),
        ...(body.source === null ? { source: null } : typeof body.source === "string" ? { source: body.source } : {}),
      });
      return memory ? response(200, { memory }) : response(404, { error: "memory not found" });
    }
    if (request.method !== "DELETE") return response(405, { error: "method not allowed" });
    const deleted = await services.memoryService.deletePrivateMemory(principal, memoryId);
    return deleted ? response(204, undefined) : response(404, { error: "memory not found" });
  }

  return response(404, { error: "not found" });
}
