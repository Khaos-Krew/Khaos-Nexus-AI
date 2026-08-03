import { createHash, randomUUID } from "node:crypto";
import { runEvaluationSuite, validateEvaluationRequest } from "./evaluations.js";
import { generationPromptRegistry } from "./production-controls.js";
import { runWithProductionContext } from "./production-context.js";
import { validateBudgetInput, validateModelPolicyInput } from "./production-control-store.js";
import { extractBearerToken } from "./supabase.js";

const MAX_BODY_BYTES = 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITIES = Object.freeze([
  "dnd.campaign.turn",
  "dnd.co-dm.draft",
  "dnd.homebrew.generate",
  "dnd.map.generate",
  "dnd.map.scene",
  "dnd.session.intelligence",
  "dnd.retrieval.search",
  "dnd.discord.bridge",
  "dnd.production.budgets",
  "dnd.production.evaluations",
  "dnd.production.monitoring",
]);

function sendJson(response, status, body, origin, requestId = null) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    ...(requestId ? { "X-Khaos-Request-Id": requestId } : {}),
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
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("Invalid JSON");
    error.status = 400;
    throw error;
  }
}

function requestId(request) {
  const value = request.headers["x-khaos-request-id"];
  if (typeof value === "string" && UUID_PATTERN.test(value)) return value;
  return randomUUID();
}

function campaignIdFromPath(pathname) {
  return /^\/api\/v1\/campaigns\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname)?.[1] ?? null;
}

function queryCampaignId(url) {
  const value = url.searchParams.get("campaignId");
  if (!value) return null;
  if (!UUID_PATTERN.test(value)) {
    const error = new Error("campaignId must be a UUID");
    error.status = 400;
    throw error;
  }
  return value;
}

function queryLimit(url) {
  const value = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    const error = new Error("limit must be an integer from 1 to 500");
    error.status = 400;
    throw error;
  }
  return value;
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

async function optionalAuth(request, dependencies) {
  const token = extractBearerToken(request);
  if (!token || !dependencies.authVerifier) return { token: token ?? null, user: null };
  try { return { token, user: await dependencies.authVerifier.verify(token) }; }
  catch { return { token, user: null }; }
}

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (error?.name === "TypeError" || error?.name === "ValidationError") return 400;
  return 500;
}

function artifactHash(value) {
  return createHash("sha256").update(JSON.stringify(value ?? {})).digest("hex");
}

export function attachProductionControlRoutes(server, {
  store,
  provider,
  authVerifier = null,
  authRequired = false,
  corsOrigin = "http://localhost:3000",
  serviceVersion = "0.11.0",
} = {}) {
  if (!server || !store || !provider) throw new Error("server, store, and provider are required");
  const required = [
    "reserveGeneration", "finalizeGeneration", "listProductionBudgets", "upsertProductionBudget",
    "listModelPolicies", "upsertModelPolicy", "listProductionUsage", "saveEvaluationRun", "listEvaluationRuns",
  ];
  for (const method of required) if (typeof store[method] !== "function") throw new Error(`The campaign store does not support ${method}`);

  const baseListeners = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", async (request, response) => {
    const origin = corsOrigin === "*" ? "*" : corsOrigin;
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    const id = requestId(request);
    const productionRoute = pathname.startsWith("/api/v1/production/");

    if (request.method === "OPTIONS" && productionRoute) {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Khaos-Request-Id",
        "Access-Control-Expose-Headers": "X-Khaos-Request-Id",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
        "X-Khaos-Request-Id": id,
      });
      response.end();
      return;
    }

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        status: "ok",
        service: "khaos-nexus-ai",
        apiVersion: "1",
        version: serviceVersion,
        provider: provider.name,
        model: provider.model,
        store: store.name ?? "unknown",
        authentication: authRequired || store.requiresAuth ? "required" : "optional",
        capabilities: CAPABILITIES,
        productionControls: {
          enabled: true,
          promptRegistryVersion: "baseline-1",
          evaluationSuiteVersion: "baseline-1",
          rawPromptOutputStorage: false,
        },
      }, origin, id);
      return;
    }

    if (!productionRoute) {
      const auth = await optionalAuth(request, { authVerifier });
      const context = {
        requestId: id,
        token: auth.token,
        userId: auth.user?.id ?? null,
        campaignId: campaignIdFromPath(pathname),
        path: pathname,
      };
      if (!response.headersSent) response.setHeader("X-Khaos-Request-Id", id);
      runWithProductionContext(context, () => {
        for (const listener of baseListeners) listener.call(server, request, response);
      });
      return;
    }

    try {
      const auth = await authenticate(request, { store, authVerifier, authRequired });
      const context = { token: auth.token, user: auth.user };
      const campaignId = queryCampaignId(url);

      if (request.method === "GET" && pathname === "/api/v1/production/prompts") {
        sendJson(response, 200, { promptRegistry: generationPromptRegistry }, origin, id); return;
      }
      if (request.method === "GET" && pathname === "/api/v1/production/budgets") {
        sendJson(response, 200, { budgets: await store.listProductionBudgets(campaignId, context) }, origin, id); return;
      }
      if (request.method === "POST" && pathname === "/api/v1/production/budgets") {
        const body = validateBudgetInput(await readJson(request));
        sendJson(response, body.budgetId ? 200 : 201, { budget: await store.upsertProductionBudget(body, context) }, origin, id); return;
      }
      if (request.method === "GET" && pathname === "/api/v1/production/model-policies") {
        sendJson(response, 200, { policies: await store.listModelPolicies(campaignId, context) }, origin, id); return;
      }
      if (request.method === "POST" && pathname === "/api/v1/production/model-policies") {
        const body = await readJson(request);
        const targetCampaignId = body.campaignId ?? campaignId;
        const policyInput = { ...body };
        delete policyInput.campaignId;
        const policy = validateModelPolicyInput(policyInput);
        sendJson(response, policy.policyId ? 200 : 201, {
          policy: await store.upsertModelPolicy(policy, targetCampaignId, context),
        }, origin, id); return;
      }
      if (request.method === "GET" && pathname === "/api/v1/production/usage") {
        sendJson(response, 200, { usage: await store.listProductionUsage(campaignId, queryLimit(url), context) }, origin, id); return;
      }
      if (request.method === "GET" && pathname === "/api/v1/production/evaluations") {
        sendJson(response, 200, { evaluations: await store.listEvaluationRuns(campaignId, queryLimit(url), context) }, origin, id); return;
      }
      if (request.method === "POST" && pathname === "/api/v1/production/evaluations") {
        const input = validateEvaluationRequest(await readJson(request));
        const report = runEvaluationSuite(input.artifact, input.categories);
        const hash = artifactHash(input.artifact);
        const persisted = input.persist
          ? await store.saveEvaluationRun({
              campaignId: input.campaignId,
              feature: input.feature,
              suiteVersion: report.suiteVersion,
              artifactHash: hash,
              outcome: report.outcome,
              report,
            }, context)
          : null;
        sendJson(response, 200, { report, artifactHash: hash, persisted }, origin, id); return;
      }
      sendJson(response, 404, { error: "Production-control route not found" }, origin, id);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 500) console.error(error);
      sendJson(response, status, { error: status === 500 ? "Internal server error" : error.message }, origin, id);
    }
  });
  return server;
}
