import { Readable } from "node:stream";
import {
  createAdvancedMapScene,
  createMapSceneExport,
  renderMapSceneSvg,
  validateMapSceneApprovalRequest,
  validateMapSceneExportRequest,
  validateMapSceneOptions,
} from "./map-scenes.js";
import { discordCommandDefinitions, discordResponse } from "./discord-bridge.js";
import { validateMapRequest } from "./maps.js";
import { extractBearerToken } from "./supabase.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAP_SCENE_COMMANDS = Object.freeze([
  { name: "generate_map_scene", description: "Generate an advanced map scene and optionally save a draft revision." },
  { name: "map_scene", description: "View the role-filtered map scene package and SVG preview." },
  { name: "approve_map_scene", description: "Approve a specific map scene revision for players." },
  { name: "export_map_scene", description: "Export a stored GM or player scene package." },
]);

function fail(message, field = "request") {
  const error = new Error(message);
  error.name = "ValidationError";
  error.field = field;
  throw error;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`, field);
  return value;
}

function strictKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key} is not allowed`, `${field}.${key}`);
  }
}

function uuid(value, field) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(`${field} must be a UUID`, field);
  return value;
}

function boolean(value, field, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") fail(`${field} must be boolean`, field);
  return value;
}

function integer(value, field, { required = false, min = 0, max = 1_000_000, defaultValue = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`, field);
    return defaultValue;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer between ${min} and ${max}`, field);
  }
  return value;
}

function text(value, field, { max = 300, defaultValue = "" } = {}) {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value !== "string") fail(`${field} must be text`, field);
  const normalized = value.trim();
  if (normalized.length > max) fail(`${field} must be ${max} characters or fewer`, field);
  return normalized;
}

function permissionError(message = "Campaign management permission is required") {
  const error = new Error(message);
  error.status = 403;
  return error;
}

function mapCommand(value) {
  const input = object(value, "body");
  strictKeys(input, ["registeredAppId", "guildId", "resourceId", "discordUserId", "command", "options"], "body");
  const command = text(input.command, "command", { max: 100 });
  if (!MAP_SCENE_COMMANDS.some((entry) => entry.name === command)) return null;
  const base = {
    registeredAppId: uuid(input.registeredAppId, "registeredAppId"),
    guildId: text(input.guildId, "guildId", { max: 25 }),
    resourceId: text(input.resourceId, "resourceId", { max: 25 }),
    discordUserId: text(input.discordUserId, "discordUserId", { max: 25 }),
    command,
  };
  for (const field of ["guildId", "resourceId", "discordUserId"]) {
    if (!/^\d{5,25}$/.test(base[field])) fail(`${field} must be a Discord snowflake`, field);
  }
  const options = object(input.options ?? {}, "options");

  if (command === "generate_map_scene") {
    strictKeys(options, ["mapRequest", "sceneOptions", "persist", "name", "expectedRevision"], "options");
    const persist = boolean(options.persist, "options.persist", false);
    return {
      ...base,
      options: {
        mapRequest: validateMapRequest(object(options.mapRequest, "options.mapRequest")),
        sceneOptions: validateMapSceneOptions(options.sceneOptions ?? {}),
        persist,
        name: text(options.name, "options.name", { max: 300 }),
        expectedRevision: integer(options.expectedRevision, "options.expectedRevision", {
          required: persist,
          min: 0,
        }),
      },
    };
  }
  if (command === "map_scene") {
    strictKeys(options, ["sceneId"], "options");
    return { ...base, options: { sceneId: uuid(options.sceneId, "options.sceneId") } };
  }
  if (command === "approve_map_scene") {
    strictKeys(options, ["sceneId", "expectedRevision"], "options");
    return {
      ...base,
      options: {
        sceneId: uuid(options.sceneId, "options.sceneId"),
        ...validateMapSceneApprovalRequest({ expectedRevision: options.expectedRevision }),
      },
    };
  }
  strictKeys(options, ["sceneId", "target", "projection"], "options");
  return {
    ...base,
    options: {
      sceneId: uuid(options.sceneId, "options.sceneId"),
      ...validateMapSceneExportRequest({ target: options.target, projection: options.projection }),
    },
  };
}

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

function replayRequest(request, body) {
  const replay = Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
  replay.url = request.url;
  replay.method = request.method;
  replay.headers = request.headers;
  replay.rawHeaders = request.rawHeaders;
  replay.httpVersion = request.httpVersion;
  replay.socket = request.socket;
  replay.connection = request.connection;
  return replay;
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

async function dispatch(input, context, { store, provider, auth }) {
  const campaignId = context.campaignId;
  if (input.command === "generate_map_scene") {
    if (!context.canManage) throw permissionError();
    const sourceMap = await provider.generateMap(input.options.mapRequest);
    const generated = createAdvancedMapScene(sourceMap, input.options.sceneOptions);
    const record = input.options.persist
      ? await store.saveMapScene(campaignId, {
          sceneId: generated.gmScene.id,
          name: input.options.name || generated.gmScene.title,
          gmScene: generated.gmScene,
          playerScene: generated.playerScene,
          expectedRevision: input.options.expectedRevision,
        }, sourceMap, auth)
      : null;
    return discordResponse({
      content: record
        ? `Generated **${generated.gmScene.title}** and saved as revision **${record.scene.revision}**.`
        : `Generated map scene: **${generated.gmScene.title}**`,
      title: generated.gmScene.title,
      description: sourceMap.summary,
      data: {
        sourceMap,
        ...generated,
        record,
        gmSvg: renderMapSceneSvg(generated.gmScene),
        playerSvg: renderMapSceneSvg(generated.playerScene),
      },
      ephemeral: true,
    });
  }

  if (input.command === "map_scene") {
    const record = await store.getMapScene(campaignId, input.options.sceneId, auth);
    if (!record) {
      const error = new Error("Map scene not found");
      error.status = 404;
      throw error;
    }
    const scene = record.canManage ? record.scene.gmScene : record.scene.playerScene;
    return discordResponse({
      content: `Map scene revision **${record.scene.revision}**${record.scene.approved ? " • approved" : " • draft"}.`,
      title: record.scene.name,
      description: `${scene.levels.length} level${scene.levels.length === 1 ? "" : "s"} • ${scene.mapType}`,
      data: { record, svg: renderMapSceneSvg(scene) },
      ephemeral: record.canManage || context.binding.purpose === "dm_private",
    });
  }

  if (input.command === "approve_map_scene") {
    if (!context.canManage) throw permissionError();
    const record = await store.approveMapScene(
      campaignId,
      input.options.sceneId,
      { expectedRevision: input.options.expectedRevision },
      auth,
    );
    return discordResponse({
      content: `Approved map scene revision **${record.scene.revision}**.`,
      title: record.scene.name,
      description: "The filtered player scene package is now visible to campaign members.",
      data: { record },
      ephemeral: true,
    });
  }

  if (!context.canManage) throw permissionError("Campaign management permission is required for exports");
  const record = await store.getMapScene(campaignId, input.options.sceneId, auth);
  if (!record) {
    const error = new Error("Map scene not found");
    error.status = 404;
    throw error;
  }
  const scene = input.options.projection === "gm" ? record.scene.gmScene : record.scene.playerScene;
  const exported = createMapSceneExport(scene, input.options.target, record.scene.revision);
  return discordResponse({
    content: `Export ready: **${exported.filename}**`,
    title: "Map scene export",
    description: `${exported.target} • ${exported.projection} • SHA-256 ${exported.hash}`,
    data: { export: exported },
    ephemeral: true,
  });
}

export function attachMapSceneDiscordRoutes(server, {
  store,
  provider,
  discordBridge,
  authVerifier = null,
  authRequired = false,
  corsOrigin = "http://localhost:3000",
} = {}) {
  if (!server || !store || !provider || !discordBridge) {
    throw new Error("server, store, provider, and discordBridge are required");
  }
  for (const method of ["getMapScene", "saveMapScene", "approveMapScene"]) {
    if (typeof store[method] !== "function") throw new Error(`The campaign store does not support ${method}`);
  }

  const baseListeners = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", async (request, response) => {
    const origin = corsOrigin === "*" ? "*" : corsOrigin;
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/v1/discord/commands") {
      for (const listener of baseListeners) listener.call(server, request, response);
      return;
    }

    try {
      if (request.method === "GET") {
        sendJson(response, 200, { commands: [...discordCommandDefinitions, ...MAP_SCENE_COMMANDS] }, origin);
        return;
      }
      if (request.method !== "POST") {
        for (const listener of baseListeners) listener.call(server, request, response);
        return;
      }

      const body = await readJson(request);
      const input = mapCommand(body);
      if (!input) {
        const replay = replayRequest(request, body);
        for (const listener of baseListeners) listener.call(server, replay, response);
        return;
      }
      const auth = await authenticate(request, { store, authVerifier, authRequired });
      const context = await discordBridge.resolveContext(input, auth);
      const discord = await dispatch(input, context, { store, provider, auth });
      sendJson(response, 200, { discord, context }, origin);
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

export { MAP_SCENE_COMMANDS as mapSceneDiscordCommandDefinitions };