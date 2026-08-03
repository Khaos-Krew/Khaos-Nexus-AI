const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validationError(message, field = "request") {
  const error = new Error(message);
  error.name = "ValidationError";
  error.field = field;
  return error;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw validationError(`${field} must be an object`, field);
  }
  return value;
}

function strictKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw validationError(`${field}.${key} is not allowed`, `${field}.${key}`);
  }
}

function text(value, field, { required = false, max = 4_000, defaultValue = "" } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw validationError(`${field} is required`, field);
    return defaultValue;
  }
  if (typeof value !== "string") throw validationError(`${field} must be text`, field);
  const normalized = value.trim();
  if (required && !normalized) throw validationError(`${field} is required`, field);
  if (normalized.length > max) throw validationError(`${field} must be ${max} characters or fewer`, field);
  return normalized;
}

function uuid(value, field, required = false) {
  if (value === undefined || value === null || value === "") {
    if (required) throw validationError(`${field} is required`, field);
    return null;
  }
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw validationError(`${field} must be a UUID`, field);
  }
  return value;
}

function boolean(value, field, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") throw validationError(`${field} must be boolean`, field);
  return value;
}

function number(value, field, { defaultValue = 1, minimum = 0, maximum = 1_000_000 } = {}) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw validationError(`${field} must be a number from ${minimum} to ${maximum}`, field);
  }
  return value;
}

function timestamp(value, field, required = false) {
  const normalized = text(value, field, { required, max: 100, defaultValue: "" });
  if (!normalized) return null;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) throw validationError(`${field} must be an ISO timestamp`, field);
  return parsed.toISOString();
}

function metadata(value, field) {
  if (value === undefined || value === null) return {};
  return object(value, field);
}

function enumValue(value, field, allowed, defaultValue) {
  const normalized = value ?? defaultValue;
  if (!allowed.includes(normalized)) {
    throw validationError(`${field} must be one of: ${allowed.join(", ")}`, field);
  }
  return normalized;
}

const simpleEntity = (args, entity) => {
  strictKeys(args, ["id", "name", "publicSummary", "gmNotes", "revealed", "metadata"], "arguments");
  return {
    id: uuid(args.id, "arguments.id"),
    name: text(args.name, "arguments.name", { required: true, max: 200 }),
    publicSummary: text(args.publicSummary, "arguments.publicSummary", { max: 8_000 }),
    gmNotes: text(args.gmNotes, "arguments.gmNotes", { max: 12_000 }),
    revealed: boolean(args.revealed, "arguments.revealed", false),
    metadata: metadata(args.metadata, "arguments.metadata"),
    entity,
  };
};

const validators = {
  upsert_npc: (args) => simpleEntity(args, "npc"),
  upsert_location: (args) => simpleEntity(args, "location"),
  upsert_faction: (args) => simpleEntity(args, "faction"),
  upsert_quest(args) {
    strictKeys(args, ["id", "title", "summary", "gmNotes", "status", "visibleToPlayers", "metadata"], "arguments");
    return {
      id: uuid(args.id, "arguments.id"),
      title: text(args.title, "arguments.title", { required: true, max: 240 }),
      summary: text(args.summary, "arguments.summary", { max: 8_000 }),
      gmNotes: text(args.gmNotes, "arguments.gmNotes", { max: 12_000 }),
      status: enumValue(args.status, "arguments.status", ["draft", "available", "active", "completed", "failed", "abandoned", "archived"], "draft"),
      visibleToPlayers: boolean(args.visibleToPlayers, "arguments.visibleToPlayers", false),
      metadata: metadata(args.metadata, "arguments.metadata"),
    };
  },
  upsert_loot(args) {
    strictKeys(args, ["id", "name", "quantity", "shared", "gmOnly", "assignedCharacterId", "metadata"], "arguments");
    return {
      id: uuid(args.id, "arguments.id"),
      name: text(args.name, "arguments.name", { required: true, max: 240 }),
      quantity: number(args.quantity, "arguments.quantity", { defaultValue: 1, minimum: 0 }),
      shared: boolean(args.shared, "arguments.shared", true),
      gmOnly: boolean(args.gmOnly, "arguments.gmOnly", false),
      assignedCharacterId: uuid(args.assignedCharacterId, "arguments.assignedCharacterId"),
      metadata: metadata(args.metadata, "arguments.metadata"),
    };
  },
  upsert_session(args) {
    strictKeys(args, ["id", "title", "status", "startsAt", "endsAt", "timezone", "agenda", "dmNotes", "recapDraft", "metadata"], "arguments");
    return {
      id: uuid(args.id, "arguments.id"),
      title: text(args.title, "arguments.title", { required: true, max: 240 }),
      status: enumValue(args.status, "arguments.status", ["draft", "planned", "confirmed", "active", "completed", "cancelled"], "planned"),
      startsAt: timestamp(args.startsAt, "arguments.startsAt"),
      endsAt: timestamp(args.endsAt, "arguments.endsAt"),
      timezone: text(args.timezone, "arguments.timezone", { max: 100, defaultValue: "UTC" }),
      agenda: text(args.agenda, "arguments.agenda", { max: 12_000 }),
      dmNotes: text(args.dmNotes, "arguments.dmNotes", { max: 12_000 }),
      recapDraft: text(args.recapDraft, "arguments.recapDraft", { max: 30_000 }),
      metadata: metadata(args.metadata, "arguments.metadata"),
    };
  },
  approve_session_recap(args) {
    strictKeys(args, ["sessionId"], "arguments");
    return { sessionId: uuid(args.sessionId, "arguments.sessionId", true) };
  },
  upsert_calendar_event(args) {
    strictKeys(args, ["id", "sessionId", "title", "startsAt", "endsAt", "timezone", "visibility", "metadata"], "arguments");
    return {
      id: uuid(args.id, "arguments.id"),
      sessionId: uuid(args.sessionId, "arguments.sessionId"),
      title: text(args.title, "arguments.title", { required: true, max: 240 }),
      startsAt: timestamp(args.startsAt, "arguments.startsAt", true),
      endsAt: timestamp(args.endsAt, "arguments.endsAt"),
      timezone: text(args.timezone, "arguments.timezone", { max: 100, defaultValue: "UTC" }),
      visibility: enumValue(args.visibility, "arguments.visibility", ["campaign", "dm_only"], "campaign"),
      metadata: metadata(args.metadata, "arguments.metadata"),
    };
  },
};

export const workspaceToolDefinitions = Object.freeze([
  { name: "upsert_npc", description: "Create or update an NPC and explicitly control player reveal state." },
  { name: "upsert_location", description: "Create or update a location and explicitly control player reveal state." },
  { name: "upsert_faction", description: "Create or update a faction and explicitly control player reveal state." },
  { name: "upsert_quest", description: "Create or update a quest, lifecycle status, and player visibility." },
  { name: "upsert_loot", description: "Create or update loot assignment, sharing, quantity, and GM-only state." },
  { name: "upsert_session", description: "Create or update a session, scheduling, agenda, DM notes, and recap draft." },
  { name: "approve_session_recap", description: "Approve a session recap for player visibility." },
  { name: "upsert_calendar_event", description: "Create or update a campaign or DM-only calendar event." },
]);

export function validateWorkspaceToolRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["tool", "arguments"], "body");
  const tool = text(input.tool, "tool", { required: true, max: 100 });
  const validate = validators[tool];
  if (!validate) throw validationError(`Unsupported workspace tool: ${tool}`, "tool");
  return { tool, arguments: validate(object(input.arguments ?? {}, "arguments")) };
}
