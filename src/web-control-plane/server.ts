import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import {
  routeWebControlPlaneRequest,
  type IdeaLabRuntimeCapability,
  type WebControlPlaneRequest,
} from "./router.js";
import { WebProductEventBus } from "./event-bus.js";

const DEFAULT_PORT = 8790;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_SSE_CONNECTION_LIMIT = 64;

type SseState = { active: number; limit: number };

export type WebControlPlaneConfig = {
  host: string;
  port: number;
  token: string;
  operatorToken?: string;
  operatorId?: string;
  modelRoot: string;
  harnessRoot: string;
  webRoot: string;
  iseolRoot?: string;
  policyRoot?: string;
  projectModelRoot?: string;
  projectHarnessRoot?: string;
};

export type StartWebControlPlaneOptions = WebControlPlaneConfig & {
  port: number;
  ideaLabRuntime?: IdeaLabRuntimeCapability;
  eventBus?: WebProductEventBus;
  sseConnectionLimit?: number;
};

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function envValue(env: Record<string, string | undefined>, name: string): string {
  return env[name]?.trim() ?? "";
}

export function resolveWebControlPlaneConfig(
  env: Record<string, string | undefined> = process.env,
): WebControlPlaneConfig {
  const host = envValue(env, "ISEOL_WEB_HOST") || "127.0.0.1";
  const portText = envValue(env, "ISEOL_WEB_PORT");
  const port = portText ? Number(portText) : DEFAULT_PORT;
  const token = envValue(env, "ISEOL_WEB_TOKEN");
  const operatorToken = envValue(env, "ISEOL_OPERATOR_TOKEN");
  const operatorId = envValue(env, "ISEOL_OPERATOR_ID");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ISEOL_WEB_PORT: ${portText}`);
  }
  if (!isLoopbackHost(host) && !token) {
    throw new Error("ISEOL_WEB_TOKEN is required for non-loopback ISEOL_WEB_HOST");
  }
  return {
    host,
    port,
    token,
    ...(operatorToken ? { operatorToken } : {}),
    ...(operatorId ? { operatorId } : {}),
    modelRoot: envValue(env, "ISEOL_MODEL_ROOT") || resolve(process.cwd(), "data", "iseol"),
    harnessRoot: envValue(env, "ISEOL_RUN_ROOT") || resolve(process.cwd(), "data", "runs"),
    webRoot: resolve(process.cwd(), "web"),
  };
}

function headerRecord(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return result;
}

async function readRequestBody(request: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large") as Error & { status?: number };
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid json") as Error & { status?: number };
    error.status = 400;
    throw error;
  }
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

function resolveStaticFile(webRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const normalized = decoded === "/" ? "/index.html" : decoded;
  const target = resolve(webRoot, `.${normalized}`);
  const relation = relative(resolve(webRoot), target);
  if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`)) return null;
  return target;
}

async function sendStatic(
  webRoot: string,
  pathname: string,
  res: import("node:http").ServerResponse,
): Promise<boolean> {
  const target = resolveStaticFile(webRoot, pathname);
  if (!target) return false;
  try {
    const content = await readFile(target);
    res.writeHead(200, { "content-type": mimeType(target), "content-length": content.length });
    res.end(content);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): void {
  const content = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, { ...headers, "content-length": content.length });
  res.end(content);
}

async function handleRequest(
  options: StartWebControlPlaneOptions,
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  sseState: SseState,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${options.host}`);
  if (url.pathname === "/api/events") {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end("method not allowed");
      return;
    }
    if (options.token && headerRecord(req.headers).authorization !== `Bearer ${options.token}`) {
      sendJson(res, 401, { "content-type": "application/json; charset=utf-8" }, { error: "unauthorized" });
      return;
    }
    if (sseState.active >= sseState.limit) {
      sendJson(res, 429, { "content-type": "application/json; charset=utf-8", "retry-after": "5" }, { error: "event stream capacity reached" });
      return;
    }
    sseState.active += 1;
    const bus = options.eventBus ?? new WebProductEventBus();
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const write = (event: { id: string; type: string; occurredAt: string; scope?: unknown; payload: unknown }) => {
      res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    write({ id: `connected-${Date.now().toString(36)}`, type: "connected", occurredAt: new Date().toISOString(), payload: { replay: false } });
    const unsubscribe = bus.subscribe(write);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": heartbeat\n\n"); }, 25_000);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sseState.active = Math.max(0, sseState.active - 1);
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    let body: unknown;
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      body = await readRequestBody(req);
    }
    const routed: WebControlPlaneRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      headers: headerRecord(req.headers),
      ...(body === undefined ? {} : { body }),
    };
    const response = await routeWebControlPlaneRequest(routed, options);
    sendJson(res, response.status, response.headers, response.body);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end("method not allowed");
    return;
  }
  if (await sendStatic(options.webRoot, url.pathname, res)) return;
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
}

export async function startWebControlPlaneServer(
  options: StartWebControlPlaneOptions,
): Promise<Server> {
  if (!isLoopbackHost(options.host) && !options.token.trim()) {
    throw new Error("ISEOL_WEB_TOKEN is required for non-loopback ISEOL_WEB_HOST");
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`Invalid Iseol web port: ${options.port}`);
  }

  const eventBus = options.eventBus ?? new WebProductEventBus();
  const sseState: SseState = { active: 0, limit: Math.max(1, Math.floor(options.sseConnectionLimit ?? DEFAULT_SSE_CONNECTION_LIMIT)) };
  const server = createServer((req, res) => {
    void handleRequest({ ...options, eventBus }, req, res, sseState).catch((error) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = Number((error as { status?: number }).status ?? 500);
      const message = status >= 500 ? "internal server error" : String((error as Error).message);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: message }));
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  return server;
}
