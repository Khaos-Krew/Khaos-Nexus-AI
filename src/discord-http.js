import { rollDice } from "./dice.js";
import {
  discordCommandDefinitions,
  discordResponse,
  validateDiscordBindingRequest,
  validateDiscordBindingVerification,
  validateDiscordCommandRequest,
} from "./discord-bridge.js";
import { retrievalCopyrightNotice, validateRetrievalResult } from "./retrieval.js";
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

function permissionError(message) {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function bindingRoute(pathname) {
  return /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/discord\/bindings$/i.exec(pathname)?.[1] ?? null;
}

function verificationRoute(pathname) {
  const match = /^\/api\/v1\/campaigns\/([0-9a-f-]{36})\/discord\/bindings\/([0-9a-f-]{36})\/verify$/i.exec(pathname);
  return match ? { campaignId: match[1], bindingId: match[2] } : null;
}

function statusResponse(workspace, context) {
  const campaign = workspace?.campaign ?? {};
  const encounterCount = Array.isArray(workspace?.encounters) ? workspace.encounters.length : 0;
  const questCount = Array.isArray(workspace?.quests) ? workspace.quests.length : 0;
  return discordResponse({
    content: `${campaign.name ?? "Campaign"} • ${context.member.role}`,
    title: campaign.name ?? "Campaign status",
    description: `Status: ${campaign.status ?? "unknown"}\nQuests: ${questCount}\nEncounters: ${encounterCount}`,
    data: { workspace, context },
    ephemeral: context.binding.purpose === "dm_private",
  });
}

async function sessionGenerationContext(store, campaignId, sessionId, auth) {
  const [campaign, workspace] = await Promise.all([
    store.get(campaignId, auth),
    store.getWorkspace(campaignId, auth),
  ]);
  if (!campaign || !workspace) {
    const error = new Error("Campaign not found");
    error.status = 404;
    throw error;
  }
  const session = workspace.sessions?.find((item) => item.id === sessionId);
  if (!session) {
    const error = new Error("Session not found");
    error.status = 404;
    throw error;
  }
  return { campaign, workspace, session };
}

function retrievalDescription(retrieval) {
  if (!retrieval.results.length) return "No authorized campaign results matched this search.";
  return retrieval.results.slice(0, 5).map((result, index) => [
    `**${index + 1}. ${result.name}**`,
    result.excerpt || "No excerpt available.",
    `Citation: \`${result.citationId}\``,
    result.attributionText ? `Attribution: ${result.attributionText}` : "",
  ].filter(Boolean).join("\n")).join("\n\n");
}

async function dispatchCommand(input, context, dependencies) {
  const { store, provider, encounterEngine } = dependencies;
  const campaignId = context.campaignId;

  switch (input.command) {
    case "campaign_status": {
      const workspace = await store.getWorkspace(campaignId, dependencies.auth);
      return statusResponse(workspace, context);
    }
    case "roll": {
      const roll = rollDice(input.options.notation);
      return discordResponse({
        content: `${roll.notation}: **${roll.total}**`,
        title: "Dice roll",
        description: `Rolls: ${roll.rolls.join(", ")} • Kept: ${roll.kept.join(", ")}`,
        data: { roll },
      });
    }
    case "homebrew": {
      const result = await provider.generateHomebrew(input.options.request);
      const homebrew = input.options.persist
        ? await store.createHomebrew(campaignId, result, dependencies.auth)
        : null;
      return discordResponse({
        content: homebrew ? `Draft saved: **${result.title}**` : `Generated: **${result.title}**`,
        title: result.title,
        description: result.summary,
        data: { result, homebrew },
        ephemeral: true,
      });
    }
    case "approve_homebrew": {
      if (!context.canManage) throw permissionError("Campaign management permission is required");
      const homebrew = await store.approveHomebrew(
        campaignId,
        input.options.homebrewId,
        dependencies.auth,
      );
      if (!homebrew) {
        const error = new Error("Homebrew entry not found");
        error.status = 404;
        throw error;
      }
      return discordResponse({
        content: `Approved homebrew: **${homebrew.name ?? homebrew.id}**`,
        title: "Homebrew approved",
        data: { homebrew },
      });
    }
    case "map": {
      const result = await provider.generateMap(input.options.request);
      const { renderMapSvg } = await import("./maps.js");
      const svg = renderMapSvg(result, input.options.request.theme);
      return discordResponse({
        content: `Generated map: **${result.title}**`,
        title: result.title,
        description: result.summary,
        data: { result, svg },
        ephemeral: true,
      });
    }
    case "encounter_state": {
      const encounter = typeof store.getEncounterState === "function"
        ? await store.getEncounterState(campaignId, input.options.encounterId, dependencies.auth)
        : encounterEngine.getState(campaignId, input.options.encounterId);
      if (!encounter) {
        const error = new Error("Encounter not found");
        error.status = 404;
        throw error;
      }
      return discordResponse({
        content: `${encounter.encounter.name} • Round ${encounter.encounter.round}`,
        title: encounter.encounter.name,
        description: `Status: ${encounter.encounter.status}\nCombatants: ${encounter.combatants.length}`,
        data: { encounter },
      });
    }
    case "workspace_tool": {
      const execution = await store.executeWorkspaceTool(
        campaignId,
        input.options.tool,
        input.options.arguments,
        dependencies.auth,
      );
      return discordResponse({
        content: `Campaign action completed: **${input.options.tool}**`,
        title: "Campaign updated",
        data: { execution },
        ephemeral: true,
      });
    }
    case "encounter_tool": {
      const execution = typeof store.executeEncounterTool === "function"
        ? await store.executeEncounterTool(
            campaignId,
            input.options.tool,
            input.options.arguments,
            dependencies.auth,
          )
        : encounterEngine.execute(campaignId, input.options.tool, input.options.arguments);
      return discordResponse({
        content: `Encounter action completed: **${input.options.tool}**`,
        title: "Encounter updated",
        data: { execution },
        ephemeral: true,
      });
    }
    case "session_intelligence": {
      const record = await store.getSessionIntelligence(
        campaignId,
        input.options.sessionId,
        dependencies.auth,
      );
      if (!record) {
        const error = new Error("Session not found");
        error.status = 404;
        throw error;
      }
      const recap = record.canManage
        ? record.intelligence?.gmRecap
        : record.intelligence?.playerRecap;
      return discordResponse({
        content: recap
          ? `Session intelligence revision **${record.revision}**${record.approved ? " • approved" : " • draft"}`
          : "No visible session intelligence is available.",
        title: record.session?.title ?? "Session intelligence",
        description: recap ?? "A campaign manager has not approved a player recap yet.",
        data: { record },
        ephemeral: record.canManage || context.binding.purpose === "dm_private",
      });
    }
    case "generate_session_intelligence": {
      if (!context.canManage) throw permissionError("Campaign management permission is required");
      const generationContext = await sessionGenerationContext(
        store,
        campaignId,
        input.options.sessionId,
        dependencies.auth,
      );
      const result = await provider.generateSessionIntelligence(
        generationContext,
        input.options.request,
      );
      const record = input.options.persist
        ? await store.saveSessionIntelligence(
            campaignId,
            input.options.sessionId,
            result,
            input.options.expectedRevision,
            dependencies.auth,
          )
        : null;
      return discordResponse({
        content: record
          ? `Session intelligence saved as revision **${record.revision}**.`
          : "Session intelligence generated for manager review.",
        title: result.sessionTitle,
        description: result.gmRecap,
        data: { result, record },
        ephemeral: true,
      });
    }
    case "approve_session_intelligence": {
      if (!context.canManage) throw permissionError("Campaign management permission is required");
      const record = await store.approveSessionIntelligence(
        campaignId,
        input.options.sessionId,
        input.options.expectedRevision,
        dependencies.auth,
      );
      return discordResponse({
        content: `Approved session intelligence revision **${record.revision}**.`,
        title: record.session?.title ?? "Session intelligence approved",
        description: record.intelligence?.playerRecap ?? "Player recap approved.",
        data: { record },
        ephemeral: true,
      });
    }
    case "search_knowledge": {
      const retrieval = validateRetrievalResult(
        await store.searchRetrieval(campaignId, input.options, dependencies.auth),
      );
      return discordResponse({
        content: `Found **${retrieval.results.length}** authorized result${retrieval.results.length === 1 ? "" : "s"}.`,
        title: "Authorized campaign knowledge",
        description: `${retrievalDescription(retrieval)}\n\n${retrievalCopyrightNotice()}`,
        data: { retrieval },
        ephemeral: context.binding.purpose === "dm_private",
      });
    }
    default:
      throw new Error(`Unsupported Discord command: ${input.command}`);
  }
}

export function attachDiscordRoutes(server, {
  store,
  provider,
  discordBridge,
  encounterEngine = null,
  authVerifier = null,
  authRequired = false,
  corsOrigin = "http://localhost:3000",
} = {}) {
  if (!server || !store || !provider || !discordBridge) {
    throw new Error("server, store, provider, and discordBridge are required");
  }
  const baseListeners = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", async (request, response) => {
    const origin = corsOrigin === "*" ? "*" : corsOrigin;
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;
    const bindingsCampaignId = bindingRoute(pathname);
    const verification = verificationRoute(pathname);
    const isDiscordRoute =
      pathname === "/api/v1/discord/commands" ||
      Boolean(bindingsCampaignId) ||
      Boolean(verification);

    if (!isDiscordRoute) {
      for (const listener of baseListeners) listener.call(server, request, response);
      return;
    }

    try {
      const auth = await authenticate(request, { store, authVerifier, authRequired });

      if (pathname === "/api/v1/discord/commands" && request.method === "GET") {
        sendJson(response, 200, { commands: discordCommandDefinitions }, origin);
        return;
      }
      if (bindingsCampaignId && request.method === "GET") {
        const bindings = await discordBridge.listBindings(bindingsCampaignId, auth);
        sendJson(response, 200, { bindings }, origin);
        return;
      }
      if (bindingsCampaignId && request.method === "POST") {
        const input = validateDiscordBindingRequest(await readJson(request));
        const binding = await discordBridge.upsertBinding(bindingsCampaignId, input, auth);
        sendJson(response, input.bindingId ? 200 : 201, { binding }, origin);
        return;
      }
      if (verification && request.method === "POST") {
        const input = validateDiscordBindingVerification(await readJson(request));
        const binding = await discordBridge.verifyBinding(
          verification.campaignId,
          verification.bindingId,
          input,
          auth,
        );
        if (!binding) {
          sendJson(response, 404, { error: "Discord binding not found" }, origin);
          return;
        }
        sendJson(response, 200, { binding }, origin);
        return;
      }
      if (pathname === "/api/v1/discord/commands" && request.method === "POST") {
        const input = validateDiscordCommandRequest(await readJson(request));
        const context = await discordBridge.resolveContext(input, auth);
        const discord = await dispatchCommand(input, context, {
          store,
          provider,
          encounterEngine,
          auth,
        });
        sendJson(response, 200, { discord, context }, origin);
        return;
      }

      sendJson(response, 405, { error: "Method not allowed" }, origin);
    } catch (error) {
      const status = Number.isInteger(error?.status)
        ? error.status
        : error?.name === "ValidationError"
          ? 400
          : 500;
      if (status === 500) console.error(error);
      sendJson(response, status, {
        error: status === 500 ? "Internal server error" : error.message,
        ...(error?.field ? { field: error.field } : {}),
      }, origin);
    }
  });
  return server;
}
