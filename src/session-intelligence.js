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

function text(value, field, { required = false, max = 8_000, defaultValue = "" } = {}) {
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

function boolean(value, field, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") fail(`${field} must be boolean`, field);
  return value;
}

function integer(value, field, { min = 0, max = 1_000_000, defaultValue = 0 } = {}) {
  if (value === undefined || value === null) return defaultValue;
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

function uuid(value, field, required = false) {
  const normalized = text(value, field, { required, max: 36 });
  if (!normalized) return "";
  if (!UUID_PATTERN.test(normalized)) fail(`${field} must be a UUID`, field);
  return normalized;
}

function array(value, field, { max = 100, defaultValue = [] } = {}) {
  if (value === undefined || value === null) return structuredClone(defaultValue);
  if (!Array.isArray(value)) fail(`${field} must be an array`, field);
  if (value.length > max) fail(`${field} must contain ${max} items or fewer`, field);
  return value;
}

function stringList(value, field, { maxItems = 40, maxLength = 1_000 } = {}) {
  return array(value, field, { max: maxItems }).map((item, index) =>
    text(item, `${field}[${index}]`, { required: true, max: maxLength }),
  );
}

export function validateSessionIntelligenceRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["sourceNotes", "transcript", "focus", "includePrep"], "body");
  return {
    sourceNotes: text(input.sourceNotes, "sourceNotes", { required: true, max: 30_000 }),
    transcript: array(input.transcript, "transcript", { max: 300 }).map((entry, index) => {
      const item = object(entry, `transcript[${index}]`);
      strictKeys(item, ["speaker", "text", "public"], `transcript[${index}]`);
      return {
        speaker: text(item.speaker, `transcript[${index}].speaker`, { required: true, max: 200 }),
        text: text(item.text, `transcript[${index}].text`, { required: true, max: 4_000 }),
        public: boolean(item.public, `transcript[${index}].public`, true),
      };
    }),
    focus: stringList(input.focus, "focus", { maxItems: 20, maxLength: 500 }),
    includePrep: boolean(input.includePrep, "includePrep", true),
  };
}

function validateCanonFact(value, index) {
  const field = `canonFacts[${index}]`;
  const item = object(value, field);
  strictKeys(item, ["statement", "confidence", "evidence", "public"], field);
  return {
    statement: text(item.statement, `${field}.statement`, { required: true, max: 2_000 }),
    confidence: enumValue(item.confidence, `${field}.confidence`, ["low", "medium", "high"], "medium"),
    evidence: text(item.evidence, `${field}.evidence`, { required: true, max: 2_000 }),
    public: boolean(item.public, `${field}.public`, false),
  };
}

function validateContradiction(value, index) {
  const field = `contradictions[${index}]`;
  const item = object(value, field);
  strictKeys(item, ["claim", "conflictsWith", "severity", "recommendation"], field);
  return {
    claim: text(item.claim, `${field}.claim`, { required: true, max: 2_000 }),
    conflictsWith: text(item.conflictsWith, `${field}.conflictsWith`, { required: true, max: 2_000 }),
    severity: enumValue(item.severity, `${field}.severity`, ["info", "warning", "blocking"], "warning"),
    recommendation: text(item.recommendation, `${field}.recommendation`, { required: true, max: 2_000 }),
  };
}

function validateThread(value, index) {
  const field = `unresolvedThreads[${index}]`;
  const item = object(value, field);
  strictKeys(item, ["thread", "status", "public", "notes"], field);
  return {
    thread: text(item.thread, `${field}.thread`, { required: true, max: 2_000 }),
    status: enumValue(item.status, `${field}.status`, ["new", "open", "resolved"], "open"),
    public: boolean(item.public, `${field}.public`, false),
    notes: text(item.notes, `${field}.notes`, { max: 2_000 }),
  };
}

function validateEntityChange(value, index) {
  const field = `entityChanges[${index}]`;
  const item = object(value, field);
  strictKeys(
    item,
    ["entityType", "entityId", "action", "summary", "proposedTool", "arguments", "public"],
    field,
  );
  const argumentsValue = item.arguments === undefined ? {} : object(item.arguments, `${field}.arguments`);
  if (JSON.stringify(argumentsValue).length > 12_000) fail(`${field}.arguments is too large`, `${field}.arguments`);
  return {
    entityType: enumValue(
      item.entityType,
      `${field}.entityType`,
      ["campaign", "npc", "location", "faction", "quest", "loot"],
      "campaign",
    ),
    entityId: uuid(item.entityId, `${field}.entityId`),
    action: enumValue(
      item.action,
      `${field}.action`,
      ["create", "update", "resolve", "reveal", "assign"],
      "update",
    ),
    summary: text(item.summary, `${field}.summary`, { required: true, max: 2_000 }),
    proposedTool: text(item.proposedTool, `${field}.proposedTool`, { max: 100 }),
    arguments: structuredClone(argumentsValue),
    public: boolean(item.public, `${field}.public`, false),
  };
}

function validatePrep(value) {
  const item = object(value, "nextSessionPrep");
  strictKeys(
    item,
    ["openingScene", "likelyNpcs", "encounterIdeas", "clues", "risks", "questions"],
    "nextSessionPrep",
  );
  return {
    openingScene: text(item.openingScene, "nextSessionPrep.openingScene", { max: 4_000 }),
    likelyNpcs: stringList(item.likelyNpcs, "nextSessionPrep.likelyNpcs", { maxItems: 30, maxLength: 500 }),
    encounterIdeas: stringList(item.encounterIdeas, "nextSessionPrep.encounterIdeas", { maxItems: 30, maxLength: 1_000 }),
    clues: stringList(item.clues, "nextSessionPrep.clues", { maxItems: 40, maxLength: 1_000 }),
    risks: stringList(item.risks, "nextSessionPrep.risks", { maxItems: 40, maxLength: 1_000 }),
    questions: stringList(item.questions, "nextSessionPrep.questions", { maxItems: 40, maxLength: 1_000 }),
  };
}

export function validateSessionIntelligenceResult(value) {
  const input = object(value, "result");
  strictKeys(
    input,
    [
      "version", "sessionTitle", "gmRecap", "playerRecap", "canonFacts", "contradictions",
      "unresolvedThreads", "entityChanges", "nextSessionPrep",
    ],
    "result",
  );
  const result = {
    version: integer(input.version, "version", { min: 1, max: 1, defaultValue: 1 }),
    sessionTitle: text(input.sessionTitle, "sessionTitle", { required: true, max: 300 }),
    gmRecap: text(input.gmRecap, "gmRecap", { required: true, max: 12_000 }),
    playerRecap: text(input.playerRecap, "playerRecap", { required: true, max: 8_000 }),
    canonFacts: array(input.canonFacts, "canonFacts", { max: 100 }).map(validateCanonFact),
    contradictions: array(input.contradictions, "contradictions", { max: 100 }).map(validateContradiction),
    unresolvedThreads: array(input.unresolvedThreads, "unresolvedThreads", { max: 100 }).map(validateThread),
    entityChanges: array(input.entityChanges, "entityChanges", { max: 100 }).map(validateEntityChange),
    nextSessionPrep: validatePrep(input.nextSessionPrep),
  };
  if (JSON.stringify(result).length > 120_000) fail("Session intelligence result is too large", "result");
  return result;
}

export function validateSessionIntelligenceSaveRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["intelligence", "expectedRevision"], "body");
  return {
    intelligence: validateSessionIntelligenceResult(input.intelligence),
    expectedRevision: integer(input.expectedRevision, "expectedRevision", { min: 0, max: 1_000_000 }),
  };
}

export function validateSessionIntelligenceApprovalRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["expectedRevision"], "body");
  return {
    expectedRevision: integer(input.expectedRevision, "expectedRevision", { min: 1, max: 1_000_000 }),
  };
}

export function playerSafeSessionIntelligence(value) {
  const result = validateSessionIntelligenceResult(value);
  return {
    version: result.version,
    sessionTitle: result.sessionTitle,
    playerRecap: result.playerRecap,
    canonFacts: result.canonFacts.filter((item) => item.public),
    unresolvedThreads: result.unresolvedThreads.filter((item) => item.public),
  };
}

const textSchema = (maxLength) => ({ type: "string", maxLength });
const stringArraySchema = (maxItems, maxLength) => ({
  type: "array",
  maxItems,
  items: textSchema(maxLength),
});

export const sessionIntelligenceResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "version", "sessionTitle", "gmRecap", "playerRecap", "canonFacts", "contradictions",
    "unresolvedThreads", "entityChanges", "nextSessionPrep",
  ],
  properties: {
    version: { type: "integer", const: 1 },
    sessionTitle: textSchema(300),
    gmRecap: textSchema(12_000),
    playerRecap: textSchema(8_000),
    canonFacts: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "confidence", "evidence", "public"],
        properties: {
          statement: textSchema(2_000),
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          evidence: textSchema(2_000),
          public: { type: "boolean" },
        },
      },
    },
    contradictions: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claim", "conflictsWith", "severity", "recommendation"],
        properties: {
          claim: textSchema(2_000),
          conflictsWith: textSchema(2_000),
          severity: { type: "string", enum: ["info", "warning", "blocking"] },
          recommendation: textSchema(2_000),
        },
      },
    },
    unresolvedThreads: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["thread", "status", "public", "notes"],
        properties: {
          thread: textSchema(2_000),
          status: { type: "string", enum: ["new", "open", "resolved"] },
          public: { type: "boolean" },
          notes: textSchema(2_000),
        },
      },
    },
    entityChanges: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entityType", "entityId", "action", "summary", "proposedTool", "arguments", "public"],
        properties: {
          entityType: { type: "string", enum: ["campaign", "npc", "location", "faction", "quest", "loot"] },
          entityId: textSchema(36),
          action: { type: "string", enum: ["create", "update", "resolve", "reveal", "assign"] },
          summary: textSchema(2_000),
          proposedTool: textSchema(100),
          arguments: { type: "object", additionalProperties: true },
          public: { type: "boolean" },
        },
      },
    },
    nextSessionPrep: {
      type: "object",
      additionalProperties: false,
      required: ["openingScene", "likelyNpcs", "encounterIdeas", "clues", "risks", "questions"],
      properties: {
        openingScene: textSchema(4_000),
        likelyNpcs: stringArraySchema(30, 500),
        encounterIdeas: stringArraySchema(30, 1_000),
        clues: stringArraySchema(40, 1_000),
        risks: stringArraySchema(40, 1_000),
        questions: stringArraySchema(40, 1_000),
      },
    },
  },
};
