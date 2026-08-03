const CONTENT_TYPES = [
  "subclass",
  "species",
  "feat",
  "spell",
  "item",
  "monster",
  "background",
  "encounter",
  "setting-element",
];

const AUTHORIZATIONS = [
  "user-owned",
  "licensed",
  "public-domain",
  "summary-only",
  "short-excerpt",
];

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

function string(value, field, { defaultValue, max = 4_000, allowEmpty = false } = {}) {
  if ((value === undefined || value === null) && defaultValue !== undefined) {
    return defaultValue;
  }
  if (typeof value !== "string") fail(`${field} must be a string`, field);
  const trimmed = value.trim();
  if (!allowEmpty && trimmed.length === 0) fail(`${field} must be a non-empty string`, field);
  if (trimmed.length > max) fail(`${field} must be ${max} characters or fewer`, field);
  return trimmed;
}

function enumValue(value, field, allowed, defaultValue) {
  const candidate = value ?? defaultValue;
  if (!allowed.includes(candidate)) fail(`${field} must be one of: ${allowed.join(", ")}`, field);
  return candidate;
}

function stringArray(value, field, { maxItems = 20, maxLength = 500 } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array`, field);
  if (value.length > maxItems) fail(`${field} may contain at most ${maxItems} items`, field);
  return value.map((item, index) => string(item, `${field}[${index}]`, { max: maxLength }));
}

function includesReconstructionRequest(text) {
  const patterns = [
    /\b(verbatim|word[- ]for[- ]word|exact text|full text|entire (?:book|chapter|section)|transcribe|scan)\b/i,
    /\b(copy|reproduce)\b.{0,50}\b(book|chapter|sourcebook|adventure|module|rules text|stat block)\b/i,
    /\b(recreate|replicate|clone)\b.{0,50}\b(exact|identical|official|published)\b/i,
    /\b(ignore|bypass|evade)\b.{0,30}\bcopyright\b/i,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

export function validateHomebrewRequest(value) {
  const input = object(value, "body");
  const concept = string(input.concept, "concept", { max: 4_000 });
  const titleHint = string(input.titleHint ?? "", "titleHint", { max: 160, allowEmpty: true });
  const constraints = stringArray(input.constraints, "constraints", {
    maxItems: 20,
    maxLength: 400,
  });
  const inspirationInput = input.inspirations ?? [];
  if (!Array.isArray(inspirationInput)) fail("inspirations must be an array", "inspirations");
  if (inspirationInput.length > 8) fail("inspirations may contain at most 8 entries", "inspirations");

  let totalInspirationCharacters = 0;
  const inspirations = inspirationInput.map((entry, index) => {
    const item = object(entry, `inspirations[${index}]`);
    const authorization = enumValue(
      item.authorization,
      `inspirations[${index}].authorization`,
      AUTHORIZATIONS,
    );
    if (item.confirmedRightToUse !== true) {
      fail(
        `inspirations[${index}].confirmedRightToUse must be true for submitted material`,
        `inspirations[${index}].confirmedRightToUse`,
      );
    }
    const summaryLimit = authorization === "short-excerpt" ? 700 : 1_800;
    const summary = string(item.summary, `inspirations[${index}].summary`, {
      max: summaryLimit,
    });
    const designSignals = stringArray(
      item.designSignals,
      `inspirations[${index}].designSignals`,
      { maxItems: 12, maxLength: 240 },
    );
    totalInspirationCharacters += summary.length + designSignals.join("").length;
    return {
      label: string(item.label, `inspirations[${index}].label`, { max: 120 }),
      authorization,
      summary,
      designSignals,
    };
  });

  if (totalInspirationCharacters > 6_000) {
    fail(
      "inspirations are too large; provide short summaries and design signals instead of source text",
      "inspirations",
    );
  }

  const combinedText = [
    concept,
    titleHint,
    ...constraints,
    ...inspirations.flatMap((item) => [item.label, item.summary, ...item.designSignals]),
  ].join("\n");
  if (includesReconstructionRequest(combinedText)) {
    fail(
      "Requests to reproduce or closely reconstruct protected source text are not supported; describe the high-level themes and mechanics you want transformed into original homebrew",
      "concept",
    );
  }

  return {
    contentType: enumValue(input.contentType, "contentType", CONTENT_TYPES),
    system: string(input.system ?? "D&D 5e-compatible", "system", { max: 100 }),
    titleHint,
    concept,
    targetTier: enumValue(input.targetTier, "targetTier", ["any", "low", "mid", "high", "epic"], "any"),
    powerLevel: enumValue(
      input.powerLevel,
      "powerLevel",
      ["conservative", "standard", "cinematic"],
      "standard",
    ),
    constraints,
    inspirations,
  };
}

export function validateHomebrewResult(value) {
  const result = object(value, "homebrewResult");
  if (!Array.isArray(result.sections)) fail("sections must be an array", "sections");
  if (!Array.isArray(result.mechanics)) fail("mechanics must be an array", "mechanics");
  const balance = object(result.balance, "balance");
  const provenance = object(result.provenance, "provenance");
  const originality = object(result.originality, "originality");
  if (provenance.rawTextStored !== false) {
    fail("provenance.rawTextStored must be false", "provenance.rawTextStored");
  }

  return {
    title: string(result.title, "title", { max: 160 }),
    contentType: enumValue(result.contentType, "contentType", CONTENT_TYPES),
    summary: string(result.summary, "summary", { max: 2_000 }),
    designGoals: stringArray(result.designGoals, "designGoals", { maxItems: 10, maxLength: 500 }),
    sections: result.sections.map((entry, index) => {
      const section = object(entry, `sections[${index}]`);
      return {
        heading: string(section.heading, `sections[${index}].heading`, { max: 120 }),
        rulesText: string(section.rulesText, `sections[${index}].rulesText`, { max: 2_500 }),
      };
    }),
    mechanics: result.mechanics.map((entry, index) => {
      const mechanic = object(entry, `mechanics[${index}]`);
      return {
        name: string(mechanic.name, `mechanics[${index}].name`, { max: 120 }),
        description: string(mechanic.description, `mechanics[${index}].description`, { max: 1_500 }),
        activation: string(mechanic.activation, `mechanics[${index}].activation`, { max: 500, allowEmpty: true }),
        limits: string(mechanic.limits, `mechanics[${index}].limits`, { max: 500, allowEmpty: true }),
        scaling: string(mechanic.scaling, `mechanics[${index}].scaling`, { max: 700, allowEmpty: true }),
      };
    }),
    balance: {
      powerBand: enumValue(balance.powerBand, "balance.powerBand", ["conservative", "standard", "cinematic"]),
      assumptions: stringArray(balance.assumptions, "balance.assumptions", { maxItems: 12, maxLength: 500 }),
      risks: stringArray(balance.risks, "balance.risks", { maxItems: 12, maxLength: 500 }),
      playtestChecks: stringArray(balance.playtestChecks, "balance.playtestChecks", { maxItems: 12, maxLength: 500 }),
    },
    provenance: {
      inspirationLabels: stringArray(provenance.inspirationLabels, "provenance.inspirationLabels", { maxItems: 8, maxLength: 120 }),
      transformedSignals: stringArray(provenance.transformedSignals, "provenance.transformedSignals", { maxItems: 20, maxLength: 300 }),
      rawTextStored: false,
      disclaimer: string(provenance.disclaimer, "provenance.disclaimer", { max: 800 }),
    },
    originality: {
      status: enumValue(originality.status, "originality.status", ["original", "needs-review"]),
      concerns: stringArray(originality.concerns, "originality.concerns", { maxItems: 12, maxLength: 500 }),
    },
  };
}

const stringArraySchema = { type: "array", items: { type: "string" } };

export const homebrewResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "contentType",
    "summary",
    "designGoals",
    "sections",
    "mechanics",
    "balance",
    "provenance",
    "originality",
  ],
  properties: {
    title: { type: "string" },
    contentType: { type: "string", enum: CONTENT_TYPES },
    summary: { type: "string" },
    designGoals: stringArraySchema,
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["heading", "rulesText"],
        properties: {
          heading: { type: "string" },
          rulesText: { type: "string" },
        },
      },
    },
    mechanics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "activation", "limits", "scaling"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          activation: { type: "string" },
          limits: { type: "string" },
          scaling: { type: "string" },
        },
      },
    },
    balance: {
      type: "object",
      additionalProperties: false,
      required: ["powerBand", "assumptions", "risks", "playtestChecks"],
      properties: {
        powerBand: { type: "string", enum: ["conservative", "standard", "cinematic"] },
        assumptions: stringArraySchema,
        risks: stringArraySchema,
        playtestChecks: stringArraySchema,
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["inspirationLabels", "transformedSignals", "rawTextStored", "disclaimer"],
      properties: {
        inspirationLabels: stringArraySchema,
        transformedSignals: stringArraySchema,
        rawTextStored: { type: "boolean", const: false },
        disclaimer: { type: "string" },
      },
    },
    originality: {
      type: "object",
      additionalProperties: false,
      required: ["status", "concerns"],
      properties: {
        status: { type: "string", enum: ["original", "needs-review"] },
        concerns: stringArraySchema,
      },
    },
  },
};
