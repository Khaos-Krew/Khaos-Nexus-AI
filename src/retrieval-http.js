import {
  retrievalCopyrightNotice,
  validateRetrievalEntryRequest,
  validateRetrievalResult,
  validateRetrievalSearchRequest,
  validateRetrievalSourceRequest,
} from "./retrieval.js";
import { extractBearerToken } from "./supabase.js";

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(response, status, body, origin) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Access-Control-Allow-Origin": origin,
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
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
}

async function authenticate(request, { store, authVerifier, authRequired }) {
  const token = extractBearerToken(request);
  if (!token) {
    if (authRequired || store.requiresAuth) {
      const error = new Error("Authorization: Bearer <access-token> is required");
      error.status = 401;
      throw error;
    }
    return { token: null, user: null };
  }
  if (!authVerifier) {
    const error = new Error("Bearer authentication is not configured on this service");
    error.status = 503;
    throw error;
  }
  return { token, user: await authVerifier.verify(token) };
}

function createRateLimiter({ windowMs = 60_000, limit = 30 } = {}) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.startedAt >= windowMs) {
      buckets.set(key, { startedAt: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };
}

function route(pathname) {
  let match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/retrieval\/sources$/i.exec(pathname);
  if (match) return { campaignId: match[1], action: "sources" };
  match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/retrieval\/sources\/([0-9a-f-]{36})\/entries$/i.exec(pathname);
  if (match) return { campaignId: match[1], sourceId: match[2], action: "entries" };
  match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/retrieval\/search$/i.exec(pathname);
  if (match) return { campaignId: match[1], action: "search" };
  return null;
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (error?.name === "ValidationError") return 400;
  return 500;
}

export function attachRetrievalRoutes(server, {
  store,
  authVerifier = null,
  authRequired = false,
  corsOrigin = "http://localhost:3000",
  rateLimit,
} = {}) {
  if (!server || !store) throw new Error("server and store are required");
  for (const method of [
    "getRetrievalSources",
    "upsertRetrievalSource",
    "upsertRetrievalEntry",
    "searchRetrieval",
  ]) {
    if (typeof store[method] !== "function") {
      throw new Error(`The campaign store does not support ${method}`);
    }
  }

  const baseListeners = server.listeners("request");
  const allowRequest = createRateLimiter(rateLimit);
  server.removeAllListeners("request");
  server.on("request", async (request, response) => {
    const origin = corsOrigin === "*" ? "*" : corsOrigin;
    const url = new URL(request.url ?? "/", "http://localhost");
    const match = route(url.pathname);
    if (!match) {
      for (const listener of baseListeners) listener.call(server, request, response);
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      });
      response.end();
      return;
    }

    try {
      const auth = await authenticate(request, { store, authVerifier, authRequired });
      const clientKey = auth.user?.id ?? request.socket.remoteAddress ?? "unknown";
      if (!allowRequest(clientKey)) {
        sendJson(response, 429, { error: "Rate limit exceeded" }, origin);
        return;
      }

      if (match.action === "sources" && request.method === "GET") {
        const retrieval = await store.getRetrievalSources(match.campaignId, auth);
        sendJson(response, 200, { retrieval }, origin);
        return;
      }

      if (match.action === "sources" && request.method === "POST") {
        const input = validateRetrievalSourceRequest(await readJson(request));
        const source = await store.upsertRetrievalSource(match.campaignId, input, auth);
        sendJson(response, input.sourceId ? 200 : 201, { source }, origin);
        return;
      }

      if (match.action === "entries" && request.method === "POST") {
        const input = validateRetrievalEntryRequest(await readJson(request));
        const entry = await store.upsertRetrievalEntry(
          match.campaignId,
          match.sourceId,
          input,
          auth,
        );
        sendJson(response, input.entryId ? 200 : 201, { entry }, origin);
        return;
      }

      if (match.action === "search" && request.method === "POST") {
        const input = validateRetrievalSearchRequest(await readJson(request));
        const retrieval = validateRetrievalResult(
          await store.searchRetrieval(match.campaignId, input, auth),
        );
        sendJson(response, 200, {
          retrieval,
          notice: retrievalCopyrightNotice(),
        }, origin);
        return;
      }

      sendJson(response, 405, { error: "Method not allowed" }, origin);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) console.error(error);
      sendJson(response, status, {
        error: status === 500 ? "Internal server error" : error.message,
        ...(error?.field ? { field: error.field } : {}),
      }, origin);
    }
  });
  return server;
}
