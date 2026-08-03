import { validateCoDmDraftRequest } from "./co-dm.js";
import { providerUsage, runWithProductionContext } from "./production-context.js";
import { extractBearerToken } from "./supabase.js";

const MAX_BODY_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendJson(response, status, body, origin, requestId) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "X-Khaos-Request-Id",
    "X-Khaos-Request-Id": requestId,
    Vary: "Origin",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    const error = new Error("Request body is required");
    error.status = 400;
    throw error;
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
}

async function authenticate(request, { store, authVerifier, authRequired }) {
  const token = extractBearerToken(request);
  if (!token) {
    if (authRequired || store.requiresAuth) {
      const error = new Error("Authentication is required");
      error.status = 401;
      throw error;
    }
    return { token: null, user: null };
  }
  if (!authVerifier) {
    const error = new Error("Service authentication is not configured");
    error.status = 503;
    throw error;
  }
  return { token, user: await authVerifier.verify(token) };
}

function createRateLimiter({ windowMs = 60_000, limit = 20 } = {}) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || now - current.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

function safeError(error) {
  if (error?.name === "ValidationError" || error?.status === 400) {
    return { status: 400, code: "INVALID_REQUEST", message: error.message, retryable: false };
  }
  if (error?.status === 401) return { status: 401, code: "AUTH_REQUIRED", message: "Authentication is required.", retryable: false };
  if (error?.status === 413) return { status: 413, code: "REQUEST_TOO_LARGE", message: "The Co-DM request is too large.", retryable: false };
  if (error?.status === 429) return { status: 429, code: "RATE_LIMITED", message: "The Co-DM request is temporarily limited by service policy or budget.", retryable: true };
  if (error?.status === 503) return { status: 503, code: "SERVICE_UNAVAILABLE", message: "The Co-DM service is unavailable.", retryable: true };
  return { status: 500, code: "GENERATION_FAILED", message: "The Co-DM draft could not be generated.", retryable: true };
}

export function attachCoDmRoutes(server, {
  store,
  provider,
  authVerifier = null,
  authRequired = false,
  corsOrigin = "http://localhost:3000",
  rateLimit,
} = {}) {
  if (!server || !store || !provider || typeof provider.generateCoDmDraft !== "function") {
    throw new Error("server, store, and a Co-DM-capable provider are required");
  }
  const baseListeners = server.listeners("request");
  const allowRequest = createRateLimiter(rateLimit);
  server.removeAllListeners("request");
  server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1/dnd/co-dm/drafts") {
      for (const listener of baseListeners) listener.call(server, request, response);
      return;
    }
    const origin = corsOrigin === "*" ? "*" : corsOrigin;
    const fallbackId = typeof request.headers["x-khaos-request-id"] === "string"
      && UUID_PATTERN.test(request.headers["x-khaos-request-id"])
      ? request.headers["x-khaos-request-id"]
      : "00000000-0000-4000-8000-000000000000";

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Khaos-Request-Id",
        "Access-Control-Expose-Headers": "X-Khaos-Request-Id",
        "Access-Control-Max-Age": "86400",
        "X-Khaos-Request-Id": fallbackId,
        Vary: "Origin",
      });
      response.end();
      return;
    }

    let responseId = fallbackId;
    try {
      if (request.method !== "POST") {
        const error = new Error("Method not allowed");
        error.status = 405;
        throw error;
      }
      const input = validateCoDmDraftRequest(await readJson(request));
      responseId = input.requestId;
      const headerId = request.headers["x-khaos-request-id"];
      if (typeof headerId !== "string" || !UUID_PATTERN.test(headerId)) {
        const error = new Error("X-Khaos-Request-Id is required and must be a UUID");
        error.status = 400;
        throw error;
      }
      if (headerId !== input.requestId) {
        const error = new Error("X-Khaos-Request-Id must match requestId");
        error.status = 400;
        throw error;
      }
      const auth = await authenticate(request, { store, authVerifier, authRequired });
      const clientKey = auth.user?.id ?? request.socket.remoteAddress ?? "unknown";
      if (!allowRequest(clientKey)) {
        const error = new Error("Rate limit exceeded");
        error.status = 429;
        throw error;
      }
      const generated = await runWithProductionContext({
        requestId: input.requestId,
        token: auth.token,
        userId: auth.user?.id ?? null,
        campaignId: null,
        path: url.pathname,
      }, async () => {
        const draft = await provider.generateCoDmDraft(input);
        return { draft, usage: providerUsage() };
      });
      const { draft, usage } = generated;
      sendJson(response, 200, {
        apiVersion: "1",
        requestId: input.requestId,
        draft: {
          content: draft.content,
          model: `${provider.name}/${provider.model}`,
          workflow: input.workflow,
        },
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        },
      }, origin, input.requestId);
    } catch (error) {
      if (error?.status === 405) {
        sendJson(response, 405, {
          apiVersion: "1",
          requestId: responseId,
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed.", retryable: false },
        }, origin, responseId);
        return;
      }
      const safe = safeError(error);
      if (safe.status === 500) console.error(error);
      sendJson(response, safe.status, {
        apiVersion: "1",
        requestId: responseId,
        error: { code: safe.code, message: safe.message, retryable: safe.retryable },
      }, origin, responseId);
    }
  });
  return server;
}
