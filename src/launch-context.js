import { randomUUID } from "node:crypto";
import {
  createBoundedRateLimiter,
  requestClientKey,
  tenantIdFromHeader,
} from "./http-security.js";
import { runWithProductionContext } from "./production-context.js";
import { extractBearerToken } from "./supabase.js";

const STATELESS_GENERATION_ROUTES = new Set([
  "/api/v1/dnd/co-dm/drafts",
  "/api/v1/homebrew/generations",
  "/api/v1/maps/generations",
]);

function requestId(request) {
  const value = request.headers["x-khaos-request-id"];
  return typeof value === "string" ? value : randomUUID();
}

export function attachLaunchContext(server, {
  store,
  corsOrigin = "http://localhost:3000",
  trustProxy = false,
  rateLimitMaxEntries = 10_000,
  rateLimit,
} = {}) {
  if (!server || !store) throw new Error("server and store are required");
  const listeners = server.listeners("request");
  const allowRequest = createBoundedRateLimiter({
    windowMs: rateLimit?.windowMs ?? 60_000,
    limit: rateLimit?.limit ?? 300,
    maxEntries: rateLimit?.maxEntries ?? rateLimitMaxEntries,
  });
  server.removeAllListeners("request");

  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const isStatelessGeneration = STATELESS_GENERATION_ROUTES.has(url.pathname);
    const origin = corsOrigin === "*" ? "*" : corsOrigin;

    if (request.method === "OPTIONS" && isStatelessGeneration) {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Khaos-Request-Id,X-Khaos-Tenant-Id",
        "Access-Control-Expose-Headers": "X-Khaos-Request-Id",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      });
      response.end();
      return;
    }

    const clientKey = requestClientKey(request, { trustProxy });
    if (!allowRequest(clientKey)) {
      response.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      });
      response.end(JSON.stringify({ error: "Rate limit exceeded" }));
      return;
    }

    try {
      const token = extractBearerToken(request);
      const tenantId = tenantIdFromHeader(request, {
        required: Boolean(store.requiresAuth && token && isStatelessGeneration && request.method === "POST"),
      });
      runWithProductionContext({
        requestId: requestId(request),
        tenantId,
        token,
        path: url.pathname,
      }, () => {
        for (const listener of listeners) listener.call(server, request, response);
      });
    } catch (error) {
      response.writeHead(400, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      });
      response.end(JSON.stringify({ error: error.message, ...(error.field ? { field: error.field } : {}) }));
    }
  });
  return server;
}
