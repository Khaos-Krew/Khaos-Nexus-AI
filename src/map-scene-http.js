import {
  createAdvancedMapScene,
  createMapSceneExport,
  renderMapSceneSvg,
  validateMapSceneApprovalRequest,
  validateMapSceneExportRequest,
  validateMapSceneOptions,
  validateMapSceneSaveRequest,
} from "./map-scenes.js";
import { validateMapRequest } from "./maps.js";
import { extractBearerToken } from "./supabase.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

function createRateLimiter({ windowMs = 60_000, limit = 20 } = {}) {
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
  let match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/map-scenes$/i.exec(pathname);
  if (match) return { campaignId: match[1], action: "collection" };
  match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/map-scenes\/generate$/i.exec(pathname);
  if (match) return { campaignId: match[1], action: "generate" };
  match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/map-scenes\/([0-9a-f-]{36})$/i.exec(pathname);
  if (match) return { campaignId: match[1], sceneId: match[2], action: "read" };
  match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/map-scenes\/([0-9a-f-]{36})\/approve$/i.exec(pathname);
  if (match) return { campaignId: match[1], sceneId: match[2], action: "approve" };
  match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/map-scenes\/([0-9a-f-]{36})\/export$/i.exec(pathname);
  if (match) return { campaignId: match[1], sceneId: match[2], action: "export" };
  return null;
}

function strictGenerateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("body must be an object");
    error.name = "ValidationError";
    error.field = "body";
    throw error;
  }
  for (const key of Object.keys(value)) {
    if (!["mapRequest", "sceneOptions"].includes(key)) {
      const error = new Error(`body.${key} is not allowed`);
      error.name = "ValidationError";
      error.field = `body.${key}`;
      throw error;
    }
  }
  return {
    mapRequest: validateMapRequest(value.mapRequest ?? {}),
    sceneOptions: validateMapSceneOptions(value.sceneOptions ?? {}),
  };
}

function strictSaveBody(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("body must be an object");
    error.name = "ValidationError";
    error.field = "body";
    throw error;
  }
  const sourceMap = value.sourceMap;
  const saveValue = { ...value };
  delete saveValue.sourceMap;
  return { input: validateMapSceneSaveRequest(saveValue), sourceMap };
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (error?.name === "ValidationError") return 400;
  return 500;
}

export function attachMapSceneRoutes(server, {
  store,
  provider,
  authVerifier = null,
  authRequired = false,
  corsOrigin = "http://localhost:3000",
  rateLimit,
} = {}) {
  if (!server || !store || !provider) throw new Error("server, store, and provider are required");
  for (const method of ["listMapScenes", "getMapScene", "saveMapScene", "approveMapScene"]) {
    if (typeof store[method] !== "function") throw new Error(`The campaign store does not support ${method}`);
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

      if (match.action === "collection" && request.method === "GET") {
        sendJson(response, 200, { mapScenes: await store.listMapScenes(match.campaignId, auth) }, origin);
        return;
      }

      if (match.action === "generate" && request.method === "POST") {
        const input = strictGenerateRequest(await readJson(request));
        const sourceMap = await provider.generateMap(input.mapRequest);
        const scene = createAdvancedMapScene(sourceMap, input.sceneOptions);
        sendJson(response, 200, {
          sourceMap,
          ...scene,
          gmSvg: renderMapSceneSvg(scene.gmScene),
          playerSvg: renderMapSceneSvg(scene.playerScene),
          meta: {
            provider: provider.name,
            model: provider.model,
            persisted: false,
            generatedAt: new Date().toISOString(),
          },
        }, origin);
        return;
      }

      if (match.action === "collection" && request.method === "POST") {
        const { input, sourceMap } = strictSaveBody(await readJson(request));
        const mapScene = await store.saveMapScene(match.campaignId, input, sourceMap, auth);
        sendJson(response, input.sceneId ? 200 : 201, { mapScene }, origin);
        return;
      }

      if (match.action === "read" && request.method === "GET") {
        const mapScene = await store.getMapScene(match.campaignId, match.sceneId, auth);
        if (!mapScene) {
          sendJson(response, 404, { error: "Map scene not found" }, origin);
          return;
        }
        sendJson(response, 200, { mapScene }, origin);
        return;
      }

      if (match.action === "approve" && request.method === "POST") {
        const input = validateMapSceneApprovalRequest(await readJson(request));
        const mapScene = await store.approveMapScene(match.campaignId, match.sceneId, input, auth);
        sendJson(response, 200, { mapScene }, origin);
        return;
      }

      if (match.action === "export" && request.method === "POST") {
        const input = validateMapSceneExportRequest(await readJson(request));
        const record = await store.getMapScene(match.campaignId, match.sceneId, auth);
        if (!record) {
          sendJson(response, 404, { error: "Map scene not found" }, origin);
          return;
        }
        if (!record.canManage) {
          sendJson(response, 403, { error: "Campaign management permission is required for exports" }, origin);
          return;
        }
        const scene = input.projection === "gm"
          ? record.scene.gmScene
          : record.scene.playerScene;
        const exported = createMapSceneExport(scene, input.target, record.scene.revision);
        sendJson(response, 200, { export: exported }, origin);
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
