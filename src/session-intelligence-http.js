import { requireExpectedRevision } from "./revision-contract.js";
import { extractBearerToken } from "./supabase.js";
import {
  validateSessionIntelligenceApprovalRequest,
  validateSessionIntelligenceRequest,
  validateSessionIntelligenceSaveRequest,
} from "./session-intelligence.js";

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
  const match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/sessions\/([0-9a-f-]{36})\/intelligence(?:\/(generate|save|approve))?$/i.exec(pathname);
  return match ? { campaignId: match[1], sessionId: match[2], action: match[3] ?? "read" } : null;
}

function managerWorkspace(workspace) {
  return workspace?.canManage === true || ["admin", "dm", "assistant_dm"].includes(workspace?.role ?? "");
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (error?.name === "ValidationError") return 400;
  return 500;
}

export function attachSessionIntelligenceRoutes(server, {
  store,
  provider,
  authVerifier = null,
  authRequired = false,
  corsOrigin = "http://localhost:3000",
  rateLimit,
} = {}) {
  if (!server || !store || !provider) throw new Error("server, store, and provider are required");
  if (typeof provider.generateSessionIntelligence !== "function") {
    throw new Error("The AI provider does not support session intelligence");
  }
  if (
    typeof store.getSessionIntelligence !== "function" ||
    typeof store.saveSessionIntelligence !== "function" ||
    typeof store.approveSessionIntelligence !== "function"
  ) {
    throw new Error("The campaign store does not support session intelligence");
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

      if (match.action === "read" && request.method === "GET") {
        const intelligence = await store.getSessionIntelligence(
          match.campaignId,
          match.sessionId,
          auth,
        );
        if (!intelligence) {
          sendJson(response, 404, { error: "Session not found" }, origin);
          return;
        }
        sendJson(response, 200, { intelligence }, origin);
        return;
      }

      if (match.action === "generate" && request.method === "POST") {
        const input = validateSessionIntelligenceRequest(await readJson(request));
        const [campaign, workspace] = await Promise.all([
          store.get(match.campaignId, auth),
          store.getWorkspace(match.campaignId, auth),
        ]);
        if (!campaign || !workspace) {
          sendJson(response, 404, { error: "Campaign not found" }, origin);
          return;
        }
        if (!managerWorkspace(workspace)) {
          sendJson(response, 403, { error: "Campaign management permission is required" }, origin);
          return;
        }
        const session = workspace.sessions?.find((item) => item.id === match.sessionId);
        if (!session) {
          sendJson(response, 404, { error: "Session not found" }, origin);
          return;
        }
        const result = await provider.generateSessionIntelligence(
          { campaign, workspace, session },
          input,
        );
        sendJson(response, 200, {
          result,
          meta: {
            provider: provider.name,
            model: provider.model,
            persisted: false,
            generatedAt: new Date().toISOString(),
          },
        }, origin);
        return;
      }

      if (match.action === "save" && request.method === "POST") {
        const body = await readJson(request);
        requireExpectedRevision(body, { minimum: 0 });
        const input = validateSessionIntelligenceSaveRequest(body);
        const intelligence = await store.saveSessionIntelligence(
          match.campaignId,
          match.sessionId,
          input.intelligence,
          input.expectedRevision,
          auth,
        );
        sendJson(response, 200, { intelligence }, origin);
        return;
      }

      if (match.action === "approve" && request.method === "POST") {
        const body = await readJson(request);
        requireExpectedRevision(body, { minimum: 1 });
        const input = validateSessionIntelligenceApprovalRequest(body);
        const intelligence = await store.approveSessionIntelligence(
          match.campaignId,
          match.sessionId,
          input.expectedRevision,
          auth,
        );
        sendJson(response, 200, { intelligence }, origin);
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
