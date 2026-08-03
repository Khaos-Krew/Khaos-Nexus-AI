const MAX_STRING = 12_000;

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

function string(value, field, { defaultValue, max = MAX_STRING } = {}) {
  if ((value === undefined || value === null) && defaultValue !== undefined) {
    return defaultValue;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`, field);
  }
  if (value.length > max) {
    fail(`${field} must be ${max} characters or fewer`, field);
  }
  return value.trim();
}

function optionalString(value, field, max = MAX_STRING) {
  if (value === undefined || value === null || value === "") return "";
  return string(value, field, { max });
}

function enumValue(value, field, allowed, defaultValue) {
  const candidate = value ?? defaultValue;
  if (!allowed.includes(candidate)) {
    fail(`${field} must be one of: ${allowed.join(", ")}`, field);
  }
  return candidate;
}

function stringArray(value, field, { maxItems = 100, maxLength = 4_000, defaults = [] } = {}) {
  const candidate = value ?? defaults;
  if (!Array.isArray(candidate)) fail(`${field} must be an array`, field);
  if (candidate.length > maxItems) fail(`${field} may contain at most ${maxItems} items`, field);
  return candidate.map((item, index) => string(item, `${field}[${index}]`, { max: maxLength }));
}

export function validateCreateCampaign(value) {
  const input = object(value, "body");
  const safetyInput = input.safety === undefined ? {} : object(input.safety, "safety");
  const charactersInput = input.playerCharacters ?? [];
  if (!Array.isArray(charactersInput) || charactersInput.length > 20) {
    fail("playerCharacters must be an array with at most 20 entries", "playerCharacters");
  }

  return {
    name: string(input.name, "name", { max: 120 }),
    system: string(input.system, "system", {
      defaultValue: "D&D 5e-compatible",
      max: 100,
    }),
    mode: enumValue(input.mode, "mode", ["gm", "co-dm"], "co-dm"),
    tone: string(input.tone, "tone", {
      defaultValue: "Heroic fantasy with meaningful choices",
      max: 500,
    }),
    contentRating: enumValue(
      input.contentRating,
      "contentRating",
      ["family", "teen", "mature"],
      "teen",
    ),
    lore: stringArray(input.lore, "lore"),
    rulesNotes: stringArray(input.rulesNotes, "rulesNotes"),
    playerCharacters: charactersInput.map((entry, index) => {
      const character = object(entry, `playerCharacters[${index}]`);
      return {
        id: typeof character.id === "string" ? character.id : undefined,
        name: string(character.name, `playerCharacters[${index}].name`, { max: 100 }),
        playerName: optionalString(
          character.playerName,
          `playerCharacters[${index}].playerName`,
          100,
        ),
        summary: optionalString(character.summary, `playerCharacters[${index}].summary`, 4_000),
      };
    }),
    safety: {
      lines: stringArray(safetyInput.lines, "safety.lines"),
      veils: stringArray(safetyInput.veils, "safety.veils"),
      pauseWords: stringArray(safetyInput.pauseWords, "safety.pauseWords", {
        defaults: ["pause", "red card"],
      }),
    },
  };
}

export function validateTurnRequest(value) {
  const input = object(value, "body");
  return {
    message: string(input.message, "message", { max: 12_000 }),
    actor: string(input.actor, "actor", { defaultValue: "Party", max: 100 }),
    dmGuidance: optionalString(input.dmGuidance, "dmGuidance", 4_000),
  };
}

export function validateDiceRequest(value) {
  const input = object(value, "body");
  return { notation: string(input.notation, "notation", { max: 30 }) };
}

export function validateTurnResult(value) {
  const result = object(value, "turnResult");
  const stateUpdates = object(result.stateUpdates, "turnResult.stateUpdates");
  const safety = object(result.safety, "turnResult.safety");
  const dialogue = result.spokenDialogue ?? [];
  const checks = result.suggestedChecks ?? [];
  if (!Array.isArray(dialogue)) fail("spokenDialogue must be an array");
  if (!Array.isArray(checks)) fail("suggestedChecks must be an array");

  return {
    narration: string(result.narration, "turnResult.narration"),
    spokenDialogue: dialogue.map((entry, index) => {
      const item = object(entry, `spokenDialogue[${index}]`);
      return {
        speaker: string(item.speaker, `spokenDialogue[${index}].speaker`),
        text: string(item.text, `spokenDialogue[${index}].text`),
      };
    }),
    suggestedChecks: checks.map((entry, index) => {
      const item = object(entry, `suggestedChecks[${index}]`);
      const dc = Number(item.dc);
      if (!Number.isInteger(dc) || dc < 1 || dc > 40) {
        fail(`suggestedChecks[${index}].dc must be an integer from 1 to 40`);
      }
      return {
        character: string(item.character, `suggestedChecks[${index}].character`),
        ability: string(item.ability, `suggestedChecks[${index}].ability`),
        skill: string(item.skill, `suggestedChecks[${index}].skill`),
        dc,
        reason: string(item.reason, `suggestedChecks[${index}].reason`),
      };
    }),
    choices: stringArray(result.choices, "turnResult.choices", { maxItems: 6 }),
    stateUpdates: {
      currentScene: optionalString(stateUpdates.currentScene, "stateUpdates.currentScene"),
      addWorldFacts: stringArray(stateUpdates.addWorldFacts, "stateUpdates.addWorldFacts"),
      addOpenThreads: stringArray(stateUpdates.addOpenThreads, "stateUpdates.addOpenThreads"),
      resolveOpenThreads: stringArray(
        stateUpdates.resolveOpenThreads,
        "stateUpdates.resolveOpenThreads",
      ),
      addNotes: stringArray(stateUpdates.addNotes, "stateUpdates.addNotes"),
    },
    safety: {
      status: enumValue(safety.status, "safety.status", ["ok", "pause", "redirect"], "ok"),
      reason: optionalString(safety.reason, "safety.reason"),
    },
  };
}

export const turnResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "narration",
    "spokenDialogue",
    "suggestedChecks",
    "choices",
    "stateUpdates",
    "safety",
  ],
  properties: {
    narration: { type: "string" },
    spokenDialogue: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["speaker", "text"],
        properties: {
          speaker: { type: "string" },
          text: { type: "string" },
        },
      },
    },
    suggestedChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["character", "ability", "skill", "dc", "reason"],
        properties: {
          character: { type: "string" },
          ability: { type: "string" },
          skill: { type: "string" },
          dc: { type: "integer", minimum: 1, maximum: 40 },
          reason: { type: "string" },
        },
      },
    },
    choices: { type: "array", maxItems: 6, items: { type: "string" } },
    stateUpdates: {
      type: "object",
      additionalProperties: false,
      required: [
        "currentScene",
        "addWorldFacts",
        "addOpenThreads",
        "resolveOpenThreads",
        "addNotes",
      ],
      properties: {
        currentScene: { type: "string" },
        addWorldFacts: { type: "array", items: { type: "string" } },
        addOpenThreads: { type: "array", items: { type: "string" } },
        resolveOpenThreads: { type: "array", items: { type: "string" } },
        addNotes: { type: "array", items: { type: "string" } },
      },
    },
    safety: {
      type: "object",
      additionalProperties: false,
      required: ["status", "reason"],
      properties: {
        status: { type: "string", enum: ["ok", "pause", "redirect"] },
        reason: { type: "string" },
      },
    },
  },
};
