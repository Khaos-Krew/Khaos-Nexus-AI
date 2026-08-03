import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rollDice } from "./dice.js";
import {
  validateCreateCampaign,
  validateDiceRequest,
  validateTurnRequest,
} from "./domain.js";
import { LocalEncounterEngine } from "./encounter-engine.js";
import { encounterToolDefinitions, validateEncounterToolRequest } from "./encounter-tools.js";
import { validateHomebrewRequest } from "./homebrew.js";
import { renderMapSvg, validateMapRequest } from "./maps.js";
import { extractBearerToken } from "./supabase.js";
import { validateWorkspaceToolRequest, workspaceToolDefinitions } from "./workspace-tools.js";

const MAX_BODY_BYTES = 256 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
}

function validationError(message, field) {
  const error = new Error(message);
  error.name = "ValidationError";
  error.field = field;
  return error;
}
function mergeUnique(existing, additions) {
  return [...new Set([...existing, ...additions].map((item) => item.trim()).filter(Boolean))];
}
function applyTurnResult(campaign, result) {
  const updates = result.stateUpdates;
  if (updates.currentScene.trim()) campaign.currentScene = updates.currentScene.trim();
  campaign.worldFacts = mergeUnique(campaign.worldFacts, updates.addWorldFacts);
  campaign.openThreads = mergeUnique(campaign.openThreads, updates.addOpenThreads).filter(
    (thread) => !updates.resolveOpenThreads.includes(thread),
  );
  campaign.notes = mergeUnique(campaign.notes, updates.addNotes).slice(-200);
}
function createRateLimiter({ windowMs = 60_000, limit = 60 } = {}) {
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
function routeCampaignId(pathname, suffix = "") {
  const pattern = suffix
    ? new RegExp(`^/api/v1/campaigns/([0-9a-f-]{36})/${suffix}$`, "i")
    : /^\/api\/v1\/campaigns\/([0-9a-f-]{36})$/i;
  return pattern.exec(pathname)?.[1] ?? null;
}
function routeHomebrewApproval(pathname) {
  const match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/homebrew\/([0-9a-f-]{36})\/approve$/i.exec(pathname);
  return match ? { campaignId: match[1], homebrewId: match[2] } : null;
}
function routeEncounterState(pathname) {
  const match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/encounters\/([0-9a-f-]{36})$/i.exec(pathname);
  return match ? { campaignId: match[1], encounterId: match[2] } : null;
}
async function authenticateRequest(request, { authVerifier, authRequired, store }) {
  const token = extractBearerToken(request);
  const mustAuthenticate = authRequired || store.requiresAuth;
  if (!token) {
    if (mustAuthenticate) {
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
function tenantIdFromBody(body, required) {
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (required && !UUID_PATTERN.test(tenantId)) {
    throw validationError("tenantId must be a valid UUID in Supabase mode", "tenantId");
  }
  return tenantId || undefined;
}

export function createApp({
  store,
  provider,
  authVerifier = null,
  authRequired = false,
  encounterEngine = null,
  corsOrigin = "http://localhost:3000",
  rateLimit,
} = {}) {
  if (!store || !provider) throw new Error("store and provider are required");
  const allowRequest = createRateLimiter(rateLimit);
  const localEncounters = encounterEngine ?? (store.requiresAuth ? null : new LocalEncounterEngine());

  return createServer(async (request, response) => {
    const origin = corsOrigin === "*" ? "*" : corsOrigin;
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
      const url = new URL(request.url ?? "/", "http://localhost");
      const { pathname } = url;
      if (request.method === "GET" && pathname === "/health") {
        sendJson(response, 200, {
          status: "ok", service: "khaos-nexus-ai", provider: provider.name, model: provider.model,
          store: store.name ?? "unknown",
          authentication: authRequired || store.requiresAuth ? "required" : "optional",
        }, origin);
        return;
      }

      const auth = await authenticateRequest(request, { authVerifier, authRequired, store });
      const clientKey = auth.user?.id ?? request.socket.remoteAddress ?? "unknown";
      if (!allowRequest(clientKey)) {
        sendJson(response, 429, { error: "Rate limit exceeded" }, origin);
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/me") {
        sendJson(response, 200, { user: auth.user }, origin); return;
      }
      if (request.method === "GET" && pathname === "/api/v1/workspace-tools") {
        sendJson(response, 200, { tools: workspaceToolDefinitions }, origin); return;
      }
      if (request.method === "GET" && pathname === "/api/v1/encounter-tools") {
        sendJson(response, 200, { tools: encounterToolDefinitions }, origin); return;
      }
      if (request.method === "GET" && pathname === "/api/v1/campaigns") {
        sendJson(response, 200, { campaigns: await store.list(auth) }, origin); return;
      }
      if (request.method === "POST" && pathname === "/api/v1/campaigns") {
        const body = await readJson(request);
        const input = validateCreateCampaign(body);
        const now = new Date().toISOString();
        const campaign = {
          ...input,
          tenantId: tenantIdFromBody(body, Boolean(store.requiresAuth)),
          playerCharacters: input.playerCharacters.map((character) => ({
            ...character, id: character.id ?? randomUUID(),
          })),
          id: randomUUID(), currentScene: "", worldFacts: [], openThreads: [], notes: [], transcript: [],
          status: "planning", createdAt: now, updatedAt: now,
        };
        sendJson(response, 201, { campaign: await store.create(campaign, auth) }, origin); return;
      }

      const encounterToolCampaignId = routeCampaignId(pathname, "encounters/tools/execute");
      if (request.method === "POST" && encounterToolCampaignId) {
        const input = validateEncounterToolRequest(await readJson(request));
        const execution = typeof store.executeEncounterTool === "function"
          ? await store.executeEncounterTool(encounterToolCampaignId, input.tool, input.arguments, auth)
          : localEncounters.execute(encounterToolCampaignId, input.tool, input.arguments);
        sendJson(response, 200, { execution }, origin); return;
      }
      const encounterRoute = routeEncounterState(pathname);
      if (request.method === "GET" && encounterRoute) {
        const encounter = typeof store.getEncounterState === "function"
          ? await store.getEncounterState(encounterRoute.campaignId, encounterRoute.encounterId, auth)
          : localEncounters.getState(encounterRoute.campaignId, encounterRoute.encounterId);
        if (!encounter) { sendJson(response, 404, { error: "Encounter not found" }, origin); return; }
        sendJson(response, 200, { encounter }, origin); return;
      }

      const toolCampaignId = routeCampaignId(pathname, "tools/execute");
      if (request.method === "POST" && toolCampaignId) {
        const input = validateWorkspaceToolRequest(await readJson(request));
        const execution = await store.executeWorkspaceTool(toolCampaignId, input.tool, input.arguments, auth);
        sendJson(response, 200, { execution }, origin); return;
      }
      const workspaceCampaignId = routeCampaignId(pathname, "workspace");
      if (request.method === "GET" && workspaceCampaignId) {
        const workspace = await store.getWorkspace(workspaceCampaignId, auth);
        if (!workspace) { sendJson(response, 404, { error: "Campaign not found" }, origin); return; }
        sendJson(response, 200, { workspace }, origin); return;
      }
      const campaignId = routeCampaignId(pathname);
      if (request.method === "GET" && campaignId) {
        const campaign = await store.get(campaignId, auth);
        if (!campaign) { sendJson(response, 404, { error: "Campaign not found" }, origin); return; }
        sendJson(response, 200, { campaign }, origin); return;
      }
      const turnCampaignId = routeCampaignId(pathname, "turns");
      if (request.method === "POST" && turnCampaignId) {
        const campaign = await store.get(turnCampaignId, auth);
        if (!campaign) { sendJson(response, 404, { error: "Campaign not found" }, origin); return; }
        const input = validateTurnRequest(await readJson(request));
        const result = await provider.generateTurn(campaign, input);
        const expectedUpdatedAt = campaign.updatedAt;
        applyTurnResult(campaign, result);
        const now = new Date().toISOString();
        campaign.transcript.push({ id: randomUUID(), at: now, actor: input.actor, input: input.message, result });
        campaign.transcript = campaign.transcript.slice(-100);
        campaign.expectedUpdatedAt = expectedUpdatedAt;
        campaign.updatedAt = now;
        const updatedCampaign = await store.update(campaign, auth);
        sendJson(response, 200, { result, campaign: updatedCampaign, meta: { provider: provider.name, model: provider.model } }, origin);
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/homebrew/generations") {
        const input = validateHomebrewRequest(await readJson(request));
        const result = await provider.generateHomebrew(input);
        sendJson(response, 200, { result, meta: {
          provider: provider.name, model: provider.model, rawInspirationStored: false,
          generatedAt: new Date().toISOString(),
        } }, origin); return;
      }
      const campaignHomebrewId = routeCampaignId(pathname, "homebrew/generations");
      if (request.method === "POST" && campaignHomebrewId) {
        const input = validateHomebrewRequest(await readJson(request));
        const result = await provider.generateHomebrew(input);
        const homebrew = await store.createHomebrew(campaignHomebrewId, result, auth);
        sendJson(response, 201, { result, homebrew, meta: {
          provider: provider.name, model: provider.model, rawInspirationStored: false,
          generatedAt: new Date().toISOString(),
        } }, origin); return;
      }
      const approval = routeHomebrewApproval(pathname);
      if (request.method === "POST" && approval) {
        const homebrew = await store.approveHomebrew(approval.campaignId, approval.homebrewId, auth);
        if (!homebrew) { sendJson(response, 404, { error: "Homebrew entry not found" }, origin); return; }
        sendJson(response, 200, { homebrew }, origin); return;
      }
      if (request.method === "POST" && pathname === "/api/v1/maps/generations") {
        const input = validateMapRequest(await readJson(request));
        const result = await provider.generateMap(input);
        sendJson(response, 200, { result, svg: renderMapSvg(result, input.theme), meta: {
          provider: provider.name, model: provider.model, seed: result.seed, reproducible: true,
          generatedAt: new Date().toISOString(),
        } }, origin); return;
      }
      if (request.method === "POST" && pathname === "/api/v1/dice/rolls") {
        const input = validateDiceRequest(await readJson(request));
        sendJson(response, 200, { roll: rollDice(input.notation) }, origin); return;
      }
      sendJson(response, 404, { error: "Route not found" }, origin);
    } catch (error) {
      const status = Number.isInteger(error?.status)
        ? error.status
        : error?.name === "ValidationError" ? 400 : 500;
      if (status === 500) console.error(error);
      sendJson(response, status, {
        error: status === 500 ? "Internal server error" : error.message,
        ...(error?.field ? { field: error.field } : {}),
      }, origin);
    }
  });
}
