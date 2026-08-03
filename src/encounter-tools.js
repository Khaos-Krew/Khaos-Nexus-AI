const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(message, field = "request") {
  const error = new Error(message);
  error.name = "ValidationError";
  error.field = field;
  throw error;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`, field);
  }
  return value;
}

function strictKeys(value, allowed, field) {
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

function boolean(value, field, defaultValue = false, required = false) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`, field);
    return defaultValue;
  }
  if (typeof value !== "boolean") fail(`${field} must be boolean`, field);
  return value;
}

function integer(value, field, { defaultValue = 0, min = -1_000, max = 100_000 } = {}) {
  if (value === undefined || value === null) return defaultValue;
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${field} must be an integer from ${min} to ${max}`, field);
  }
  return value;
}

function enumValue(value, field, allowed, defaultValue) {
  const normalized = value ?? defaultValue;
  if (!allowed.includes(normalized)) fail(`${field} must be one of: ${allowed.join(", ")}`, field);
  return normalized;
}

function metadata(value, field) {
  if (value === undefined || value === null) return {};
  return object(value, field);
}

const encounterId = (args) => uuid(args.encounterId, "arguments.encounterId", true);
const combatantId = (args) => uuid(args.combatantId, "arguments.combatantId", true);

const validators = {
  create_encounter(args) {
    strictKeys(args, ["name", "sessionId", "status", "metadata"], "arguments");
    return {
      name: text(args.name, "arguments.name", { required: true, max: 240 }),
      sessionId: uuid(args.sessionId, "arguments.sessionId"),
      status: enumValue(args.status, "arguments.status", ["draft", "ready"], "draft"),
      metadata: metadata(args.metadata, "arguments.metadata"),
    };
  },
  set_encounter_status(args) {
    strictKeys(args, ["encounterId", "status"], "arguments");
    return {
      encounterId: encounterId(args),
      status: enumValue(
        args.status,
        "arguments.status",
        ["draft", "ready", "active", "paused", "completed", "archived"],
      ),
    };
  },
  add_combatant(args) {
    strictKeys(
      args,
      [
        "encounterId", "characterId", "npcId", "name", "initiative", "dexterity",
        "hp", "maxHp", "tempHp", "armorClass", "hidden", "team",
        "legendaryActionsMax", "isLairActor", "metadata",
      ],
      "arguments",
    );
    const characterId = uuid(args.characterId, "arguments.characterId");
    const npcId = uuid(args.npcId, "arguments.npcId");
    if (characterId && npcId) fail("Provide characterId or npcId, not both", "arguments");
    const result = {
      encounterId: encounterId(args),
      characterId,
      npcId,
      name: text(args.name, "arguments.name", { max: 240 }),
      initiative: integer(args.initiative, "arguments.initiative", { min: -100, max: 200 }),
      dexterity: integer(args.dexterity, "arguments.dexterity", { min: 0, max: 100 }),
      tempHp: integer(args.tempHp, "arguments.tempHp", { min: 0 }),
      hidden: boolean(args.hidden, "arguments.hidden"),
      team: text(args.team, "arguments.team", { max: 100, defaultValue: "neutral" }),
      legendaryActionsMax: integer(args.legendaryActionsMax, "arguments.legendaryActionsMax", { min: 0, max: 10 }),
      isLairActor: boolean(args.isLairActor, "arguments.isLairActor"),
      metadata: metadata(args.metadata, "arguments.metadata"),
    };
    if (args.hp !== undefined) result.hp = args.hp === null ? null : integer(args.hp, "arguments.hp", { min: 0 });
    if (args.maxHp !== undefined) result.maxHp = args.maxHp === null ? null : integer(args.maxHp, "arguments.maxHp", { min: 0 });
    if (args.armorClass !== undefined) {
      result.armorClass = args.armorClass === null
        ? null
        : integer(args.armorClass, "arguments.armorClass", { min: 0, max: 100 });
    }
    return result;
  },
  set_initiative(args) {
    strictKeys(args, ["combatantId", "initiative", "dexterity"], "arguments");
    if (args.initiative === undefined) fail("arguments.initiative is required", "arguments.initiative");
    if (args.dexterity === undefined) fail("arguments.dexterity is required", "arguments.dexterity");
    return {
      combatantId: combatantId(args),
      initiative: integer(args.initiative, "arguments.initiative", { min: -100, max: 200 }),
      dexterity: integer(args.dexterity, "arguments.dexterity", { min: 0, max: 100 }),
    };
  },
  advance_turn(args) {
    strictKeys(args, ["encounterId"], "arguments");
    return { encounterId: encounterId(args) };
  },
  rewind_turn(args) {
    strictKeys(args, ["encounterId"], "arguments");
    return { encounterId: encounterId(args) };
  },
  apply_damage(args) {
    strictKeys(args, ["combatantId", "amount", "damageType", "source"], "arguments");
    if (args.amount === undefined) fail("arguments.amount is required", "arguments.amount");
    return {
      combatantId: combatantId(args),
      amount: integer(args.amount, "arguments.amount", { min: 0, max: 100_000 }),
      damageType: text(args.damageType, "arguments.damageType", { max: 100 }),
      source: text(args.source, "arguments.source", { max: 500 }),
    };
  },
  heal(args) {
    strictKeys(args, ["combatantId", "amount", "source"], "arguments");
    if (args.amount === undefined) fail("arguments.amount is required", "arguments.amount");
    return {
      combatantId: combatantId(args),
      amount: integer(args.amount, "arguments.amount", { min: 0, max: 100_000 }),
      source: text(args.source, "arguments.source", { max: 500 }),
    };
  },
  set_combatant_stats(args) {
    strictKeys(args, ["combatantId", "hp", "maxHp", "tempHp", "armorClass"], "arguments");
    const result = { combatantId: combatantId(args) };
    if (args.hp !== undefined) result.hp = integer(args.hp, "arguments.hp", { min: 0 });
    if (args.maxHp !== undefined) result.maxHp = integer(args.maxHp, "arguments.maxHp", { min: 0 });
    if (args.tempHp !== undefined) result.tempHp = integer(args.tempHp, "arguments.tempHp", { min: 0 });
    if (args.armorClass !== undefined) result.armorClass = integer(args.armorClass, "arguments.armorClass", { min: 0, max: 100 });
    if (Object.keys(result).length === 1) fail("At least one combatant stat is required", "arguments");
    return result;
  },
  add_condition(args) {
    strictKeys(args, ["combatantId", "condition", "details"], "arguments");
    return {
      combatantId: combatantId(args),
      condition: text(args.condition, "arguments.condition", { required: true, max: 100 }).toLowerCase(),
      details: metadata(args.details, "arguments.details"),
    };
  },
  remove_condition(args) {
    strictKeys(args, ["combatantId", "condition"], "arguments");
    return {
      combatantId: combatantId(args),
      condition: text(args.condition, "arguments.condition", { required: true, max: 100 }).toLowerCase(),
    };
  },
  set_concentration(args) {
    strictKeys(args, ["combatantId", "active", "effect", "source"], "arguments");
    return {
      combatantId: combatantId(args),
      active: boolean(args.active, "arguments.active", false, true),
      effect: text(args.effect, "arguments.effect", { max: 500 }),
      source: text(args.source, "arguments.source", { max: 500 }),
    };
  },
  set_reaction(args) {
    strictKeys(args, ["combatantId", "available"], "arguments");
    return {
      combatantId: combatantId(args),
      available: boolean(args.available, "arguments.available", false, true),
    };
  },
  record_death_save(args) {
    strictKeys(args, ["combatantId", "outcome"], "arguments");
    return {
      combatantId: combatantId(args),
      outcome: enumValue(
        args.outcome,
        "arguments.outcome",
        ["success", "failure", "natural-20", "natural-1", "reset"],
      ),
    };
  },
  set_legendary_actions(args) {
    strictKeys(args, ["combatantId", "maximum", "remaining"], "arguments");
    if (args.maximum === undefined) fail("arguments.maximum is required", "arguments.maximum");
    const maximum = integer(args.maximum, "arguments.maximum", { min: 0, max: 10 });
    const remaining = integer(args.remaining, "arguments.remaining", { defaultValue: maximum, min: 0, max: 10 });
    if (remaining > maximum) fail("arguments.remaining cannot exceed maximum", "arguments.remaining");
    return { combatantId: combatantId(args), maximum, remaining };
  },
  set_combatant_visibility(args) {
    strictKeys(args, ["combatantId", "hidden", "active"], "arguments");
    return {
      combatantId: combatantId(args),
      hidden: boolean(args.hidden, "arguments.hidden", false, true),
      active: boolean(args.active, "arguments.active", true, true),
    };
  },
};

const descriptions = {
  create_encounter: "Create an encounter.",
  set_encounter_status: "Change encounter lifecycle status.",
  add_combatant: "Add a character, NPC, or custom combatant.",
  set_initiative: "Set initiative and dexterity tie breaker.",
  advance_turn: "Advance initiative and round state.",
  rewind_turn: "Rewind initiative and round state.",
  apply_damage: "Apply damage with temporary-HP absorption.",
  heal: "Restore HP up to maximum.",
  set_combatant_stats: "Set HP, temporary HP, maximum HP, or armor class.",
  add_condition: "Add a condition with optional details.",
  remove_condition: "Remove a condition.",
  set_concentration: "Start or end concentration.",
  set_reaction: "Spend or restore a reaction.",
  record_death_save: "Record or reset a death save.",
  set_legendary_actions: "Set legendary action capacity and remaining uses.",
  set_combatant_visibility: "Hide, reveal, activate, or deactivate a combatant.",
};

export const encounterToolDefinitions = Object.freeze(
  Object.keys(validators).map((name) => ({ name, description: descriptions[name] })),
);

export function validateEncounterToolRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["tool", "arguments"], "body");
  const tool = text(input.tool, "tool", { required: true, max: 100 });
  const validate = validators[tool];
  if (!validate) fail(`Unsupported encounter tool: ${tool}`, "tool");
  return { tool, arguments: validate(object(input.arguments ?? {}, "arguments")) };
}
