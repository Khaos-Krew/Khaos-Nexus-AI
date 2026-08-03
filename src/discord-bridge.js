import { validateDiceRequest } from "./domain.js";
import { validateEncounterToolRequest } from "./encounter-tools.js";
import { validateHomebrewRequest } from "./homebrew.js";
import { validateMapRequest } from "./maps.js";
import { validateRetrievalSearchRequest } from "./retrieval.js";
import {
  validateSessionIntelligenceApprovalRequest,
  validateSessionIntelligenceRequest,
} from "./session-intelligence.js";
import { validateWorkspaceToolRequest } from "./workspace-tools.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNOWFLAKE_PATTERN = /^\d{5,25}$/;

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
function keys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key} is not allowed`, `${field}.${key}`);
  }
}
function text(value, field, { required = false, max = 4_000, defaultValue = "" } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${field} is required`, field);
    return defaultValue;
  }
  if (typeof value !== "string") fail(`${field} must be text`, field);
  const normalized = value.trim();
  if (required && !normalized) fail(`${field} is required`, field);
  if (normalized.length > max) fail(`${field} must be ${max} characters or fewer`, field);
  return normalized;
}
function uuid(value, field, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${field} is required`, field);
    return null;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(`${field} must be a UUID`, field);
  return value;
}
function snowflake(value, field, required = true) {
  const normalized = text(value, field, { required, max: 25 });
  if (!normalized) return null;
  if (!SNOWFLAKE_PATTERN.test(normalized)) fail(`${field} must be a Discord snowflake`, field);
  return normalized;
}
function boolean(value, field, defaultValue = false, required = false) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`, field);
    return defaultValue;
  }
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
function enumValue(value, field, allowed, defaultValue) {
  const normalized = value ?? defaultValue;
  if (!allowed.includes(normalized)) fail(`${field} must be one of: ${allowed.join(", ")}`, field);
  return normalized;
}

const PURPOSES = ["main", "dm_private", "dice_log", "character_chat", "session_notes", "loot", "announcements"];

export function validateDiscordBindingRequest(value) {
  const input = object(value, "body");
  keys(
    input,
    [
      "bindingId", "registeredAppId", "guildId", "resourceType", "resourceId",
      "parentChannelId", "displayName", "purpose", "isPrimary", "active",
    ],
    "body",
  );
  return {
    bindingId: uuid(input.bindingId, "bindingId"),
    registeredAppId: uuid(input.registeredAppId, "registeredAppId", true),
    guildId: snowflake(input.guildId, "guildId"),
    resourceType: enumValue(input.resourceType, "resourceType", ["channel", "thread", "forum_post"], "channel"),
    resourceId: snowflake(input.resourceId, "resourceId"),
    parentChannelId: snowflake(input.parentChannelId, "parentChannelId", false),
    displayName: text(input.displayName, "displayName", { max: 200 }),
    purpose: enumValue(input.purpose, "purpose", PURPOSES, "main"),
    isPrimary: boolean(input.isPrimary, "isPrimary", false),
    active: boolean(input.active, "active", true),
  };
}

export function validateDiscordBindingVerification(value) {
  const input = object(value, "body");
  keys(input, ["verified", "errorCode"], "body");
  return {
    verified: boolean(input.verified, "verified", false, true),
    errorCode: text(input.errorCode, "errorCode", { max: 120 }),
  };
}

export const discordCommandDefinitions = Object.freeze([
  { name: "campaign_status", description: "Show role-filtered campaign status." },
  { name: "roll", description: "Roll validated dice notation." },
  { name: "homebrew", description: "Generate original homebrew and optionally persist a draft." },
  { name: "approve_homebrew", description: "Approve a persisted homebrew revision as a manager." },
  { name: "map", description: "Generate a structured map and SVG preview." },
  { name: "encounter_state", description: "Show role-filtered encounter state." },
  { name: "workspace_tool", description: "Execute a manager-authorized campaign workspace tool." },
  { name: "encounter_tool", description: "Execute an authorized encounter mutation." },
  { name: "session_intelligence", description: "Show role-filtered approved recap or manager intelligence." },
  { name: "generate_session_intelligence", description: "Generate and optionally save a manager-reviewed session draft." },
  { name: "approve_session_intelligence", description: "Approve a specific session intelligence revision." },
  { name: "search_knowledge", description: "Search campaign-authorized sources with stable citations." },
]);

export function validateDiscordCommandRequest(value) {
  const input = object(value, "body");
  keys(
    input,
    ["registeredAppId", "guildId", "resourceId", "discordUserId", "command", "options"],
    "body",
  );
  const base = {
    registeredAppId: uuid(input.registeredAppId, "registeredAppId", true),
    guildId: snowflake(input.guildId, "guildId"),
    resourceId: snowflake(input.resourceId, "resourceId"),
    discordUserId: snowflake(input.discordUserId, "discordUserId"),
    command: text(input.command, "command", { required: true, max: 100 }),
  };
  const options = object(input.options ?? {}, "options");

  switch (base.command) {
    case "campaign_status":
      keys(options, [], "options");
      return { ...base, options: {} };
    case "roll":
      return { ...base, options: validateDiceRequest(options) };
    case "homebrew": {
      keys(options, ["request", "persist"], "options");
      return {
        ...base,
        options: {
          request: validateHomebrewRequest(object(options.request, "options.request")),
          persist: boolean(options.persist, "options.persist", false),
        },
      };
    }
    case "approve_homebrew":
      keys(options, ["homebrewId"], "options");
      return { ...base, options: { homebrewId: uuid(options.homebrewId, "options.homebrewId", true) } };
    case "map":
      keys(options, ["request"], "options");
      return { ...base, options: { request: validateMapRequest(object(options.request, "options.request")) } };
    case "encounter_state":
      keys(options, ["encounterId"], "options");
      return { ...base, options: { encounterId: uuid(options.encounterId, "options.encounterId", true) } };
    case "workspace_tool":
      return { ...base, options: validateWorkspaceToolRequest(options) };
    case "encounter_tool":
      return { ...base, options: validateEncounterToolRequest(options) };
    case "session_intelligence":
      keys(options, ["sessionId"], "options");
      return { ...base, options: { sessionId: uuid(options.sessionId, "options.sessionId", true) } };
    case "generate_session_intelligence": {
      keys(options, ["sessionId", "request", "persist", "expectedRevision"], "options");
      const persist = boolean(options.persist, "options.persist", false);
      return {
        ...base,
        options: {
          sessionId: uuid(options.sessionId, "options.sessionId", true),
          request: validateSessionIntelligenceRequest(object(options.request, "options.request")),
          persist,
          expectedRevision: integer(options.expectedRevision, "options.expectedRevision", {
            required: persist,
            min: 0,
          }),
        },
      };
    }
    case "approve_session_intelligence":
      keys(options, ["sessionId", "expectedRevision"], "options");
      return {
        ...base,
        options: {
          sessionId: uuid(options.sessionId, "options.sessionId", true),
          ...validateSessionIntelligenceApprovalRequest({
            expectedRevision: options.expectedRevision,
          }),
        },
      };
    case "search_knowledge":
      return { ...base, options: validateRetrievalSearchRequest(options) };
    default:
      fail(`Unsupported Discord command: ${base.command}`, "command");
  }
}

export function discordResponse({ content, title = "", description = "", data = null, ephemeral = false }) {
  return {
    content: text(content, "response.content", { max: 2_000 }),
    ephemeral: Boolean(ephemeral),
    embeds: title || description
      ? [{ title: title.slice(0, 256), description: description.slice(0, 4_096), fields: [] }]
      : [],
    data,
  };
}
