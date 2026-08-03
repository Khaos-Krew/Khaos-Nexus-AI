import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rollDice } from "./dice.js";
import {
  validateCreateCampaign,
  validateDiceRequest,
  validateTurnRequest,
} from "./domain.js";
import { renderMapSvg, validateMapRequest } from "./maps.js";

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
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
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

export function createApp({ store, provider, corsOrigin = "http://localhost:3000", rateLimit } = {}) {
  if (!store || !provider) throw new Error("store and provider are required");
  const allowRequest = createRateLimiter(rateLimit);

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

    const clientKey = request.socket.remoteAddress ?? "unknown";
    if (!allowRequest(clientKey)) {
      sendJson(response, 429, { error: "Rate limit exceeded" }, origin);
      return;
    }

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const { pathname } = url;

      if (request.method === "GET" && pathname === "/health") {
        sendJson(
          response,
          200,
          { status: "ok", service: "khaos-nexus-ai", provider: provider.name, model: provider.model },
          origin,
        );
        return;
      }

      if (request.method === "GET" && pathname === "/api/v1/campaigns") {
        sendJson(response, 200, { campaigns: await store.list() }, origin);
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/campaigns") {
        const input = validateCreateCampaign(await readJson(request));
        const now = new Date().toISOString();
        const campaign = {
          ...input,
          playerCharacters: input.playerCharacters.map((character) => ({
            ...character,
            id: character.id ?? randomUUID(),
          })),
          id: randomUUID(),
          currentScene: "",
          worldFacts: [],
          openThreads: [],
          notes: [],
          transcript: [],
          createdAt: now,
          updatedAt: now,
        };
        await store.save(campaign);
        sendJson(response, 201, { campaign }, origin);
        return;
      }

      const campaignId = routeCampaignId(pathname);
      if (request.method === "GET" && campaignId) {
        const campaign = await store.get(campaignId);
        if (!campaign) {
          sendJson(response, 404, { error: "Campaign not found" }, origin);
          return;
        }
        sendJson(response, 200, { campaign }, origin);
        return;
      }

      const turnCampaignId = routeCampaignId(pathname, "turns");
      if (request.method === "POST" && turnCampaignId) {
        const campaign = await store.get(turnCampaignId);
        if (!campaign) {
          sendJson(response, 404, { error: "Campaign not found" }, origin);
          return;
        }
        const input = validateTurnRequest(await readJson(request));
        const result = await provider.generateTurn(campaign, input);
        applyTurnResult(campaign, result);
        const now = new Date().toISOString();
        campaign.transcript.push({
          id: randomUUID(),
          at: now,
          actor: input.actor,
          input: input.message,
          result,
        });
        campaign.transcript = campaign.transcript.slice(-100);
        campaign.updatedAt = now;
        await store.save(campaign);
        sendJson(
          response,
          200,
          { result, campaign, meta: { provider: provider.name, model: provider.model } },
          origin,
        );
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/maps/generations") {
        const input = validateMapRequest(await readJson(request));
        const result = await provider.generateMap(input);
        sendJson(
          response,
          200,
          {
            result,
            svg: renderMapSvg(result, input.theme),
            meta: {
              provider: provider.name,
              model: provider.model,
              seed: result.seed,
              reproducible: true,
              generatedAt: new Date().toISOString(),
            },
          },
          origin,
        );
        return;
      }

      if (request.method === "POST" && pathname === "/api/v1/dice/rolls") {
        const input = validateDiceRequest(await readJson(request));
        sendJson(response, 200, { roll: rollDice(input.notation) }, origin);
        return;
      }

      sendJson(response, 404, { error: "Route not found" }, origin);
    } catch (error) {
      const status = Number.isInteger(error?.status)
        ? error.status
        : error?.name === "ValidationError"
          ? 400
          : 500;
      if (status === 500) console.error(error);
      sendJson(
        response,
        status,
        {
          error: status === 500 ? "Internal server error" : error.message,
          ...(error?.field ? { field: error.field } : {}),
        },
        origin,
      );
    }
  });
}
