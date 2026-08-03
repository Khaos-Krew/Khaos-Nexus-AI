const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const URL_PATTERN = /^https:\/\//i;

export const RETRIEVAL_LICENSE_TYPES = Object.freeze([
  "srd_cc_by",
  "user_authored",
  "user_supplied_private",
  "metadata_only",
  "external_link",
  "partner_api",
  "unknown_restricted",
]);

export const RETRIEVAL_CONTENT_ORIGINS = Object.freeze([
  "metadata_only",
  "user_authored",
  "licensed_full_text",
  "licensed_summary",
  "public_domain",
  "partner_api",
  "external_reference",
  "campaign_generated",
]);

const SOURCE_VISIBILITIES = ["manager_only", "campaign_members"];
const ENTRY_VISIBILITIES = ["inherit", "manager_only", "campaign_members"];
const FULL_TEXT_LICENSES = ["srd_cc_by", "user_authored", "user_supplied_private", "partner_api"];
const RECONSTRUCTION_PATTERN = /(verbatim|exact[ -]?copy|full[ -]?text|entire\s+(book|chapter|module|adventure|source)|whole\s+(book|chapter|module|adventure|source)|reproduce|reconstruct|pages?\s+\d+\s*(-|through|to)\s*\d+|continue\s+from\s+(the\s+)?previous)/i;

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

function boolean(value, field, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "boolean") fail(`${field} must be boolean`, field);
  return value;
}

function integer(value, field, { min = 1, max = 10, defaultValue = 8 } = {}) {
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
  if (!normalized) return null;
  if (!UUID_PATTERN.test(normalized)) fail(`${field} must be a UUID`, field);
  return normalized;
}

function metadata(value, field) {
  if (value === undefined || value === null) return {};
  const result = object(value, field);
  if (JSON.stringify(result).length > 12_000) fail(`${field} is too large`, field);
  return structuredClone(result);
}

function requireHttpsUrl(value, field, required) {
  const normalized = text(value, field, { required, max: 2_000 });
  if (normalized && !URL_PATTERN.test(normalized)) fail(`${field} must use https`, field);
  return normalized;
}

export function validateRetrievalSourceRequest(value) {
  const input = object(value, "body");
  strictKeys(input, [
    "sourceId", "name", "ruleset", "sourceVersion", "licenseType",
    "licenseReference", "attributionText", "externalReferenceUrl",
    "fullTextAllowed", "visibility", "enabled", "confirmedRightToUse",
  ], "body");

  const licenseType = enumValue(input.licenseType, "licenseType", RETRIEVAL_LICENSE_TYPES);
  const fullTextAllowed = boolean(input.fullTextAllowed, "fullTextAllowed", false);
  const licenseReference = text(input.licenseReference, "licenseReference", { max: 1_000 });
  const attributionText = text(input.attributionText, "attributionText", { max: 2_000 });
  const externalReferenceUrl = requireHttpsUrl(
    input.externalReferenceUrl,
    "externalReferenceUrl",
    ["external_link", "partner_api"].includes(licenseType),
  );
  const confirmedRightToUse = boolean(input.confirmedRightToUse, "confirmedRightToUse", false);

  if (licenseType === "srd_cc_by" && !attributionText) {
    fail("attributionText is required for SRD CC BY sources", "attributionText");
  }
  if (fullTextAllowed && !FULL_TEXT_LICENSES.includes(licenseType)) {
    fail("fullTextAllowed is incompatible with this license type", "fullTextAllowed");
  }
  if (fullTextAllowed && !confirmedRightToUse) {
    fail("confirmedRightToUse must be true for full-text sources", "confirmedRightToUse");
  }
  if (
    fullTextAllowed &&
    ["user_supplied_private", "partner_api"].includes(licenseType) &&
    !licenseReference
  ) {
    fail("licenseReference is required for this full-text source", "licenseReference");
  }

  return {
    sourceId: uuid(input.sourceId, "sourceId"),
    name: text(input.name, "name", { required: true, max: 240 }),
    ruleset: text(input.ruleset, "ruleset", { max: 120 }),
    sourceVersion: text(input.sourceVersion, "sourceVersion", { max: 120 }),
    licenseType,
    licenseReference,
    attributionText,
    externalReferenceUrl,
    fullTextAllowed,
    visibility: enumValue(input.visibility, "visibility", SOURCE_VISIBILITIES, "manager_only"),
    enabled: boolean(input.enabled, "enabled", true),
    confirmedRightToUse,
  };
}

export function validateRetrievalEntryRequest(value) {
  const input = object(value, "body");
  strictKeys(input, [
    "entryId", "contentType", "name", "summary", "fullText",
    "contentOrigin", "visibility", "metadata", "confirmedRightToUse",
  ], "body");

  const fullText = text(input.fullText, "fullText", { max: 50_000 });
  const contentOrigin = enumValue(
    input.contentOrigin,
    "contentOrigin",
    RETRIEVAL_CONTENT_ORIGINS,
    "metadata_only",
  );
  const confirmedRightToUse = boolean(input.confirmedRightToUse, "confirmedRightToUse", false);

  if (contentOrigin === "metadata_only" && fullText) {
    fail("metadata_only entries cannot contain fullText", "fullText");
  }
  if (contentOrigin === "licensed_full_text" && !fullText) {
    fail("licensed_full_text entries require fullText", "fullText");
  }
  if (fullText && !confirmedRightToUse) {
    fail("confirmedRightToUse must be true when fullText is submitted", "confirmedRightToUse");
  }

  return {
    entryId: uuid(input.entryId, "entryId"),
    contentType: text(input.contentType, "contentType", { required: true, max: 100 }),
    name: text(input.name, "name", { required: true, max: 300 }),
    summary: text(input.summary, "summary", { max: 4_000 }),
    fullText,
    contentOrigin,
    visibility: enumValue(input.visibility, "visibility", ENTRY_VISIBILITIES, "inherit"),
    metadata: metadata(input.metadata, "metadata"),
    confirmedRightToUse,
  };
}

export function validateRetrievalSearchRequest(value) {
  const input = object(value, "body");
  strictKeys(input, ["query", "limit"], "body");
  const query = text(input.query, "query", { required: true, max: 500 });
  if (query.length < 3) fail("query must be at least 3 characters", "query");
  if (RECONSTRUCTION_PATTERN.test(query)) {
    fail("Retrieval cannot reconstruct or export source text", "query");
  }
  return {
    query,
    limit: integer(input.limit, "limit", { min: 1, max: 10, defaultValue: 8 }),
  };
}

export function validateRetrievalResult(value) {
  const result = object(value, "result");
  const results = Array.isArray(result.results) ? result.results : fail("result.results must be an array", "result.results");
  if (results.length > 10) fail("result.results cannot contain more than 10 items", "result.results");
  return {
    role: text(result.role, "result.role", { required: true, max: 50 }),
    canManage: Boolean(result.canManage),
    query: text(result.query, "result.query", { required: true, max: 500 }),
    excerptLimit: integer(result.excerptLimit, "result.excerptLimit", { min: 1, max: 700, defaultValue: 700 }),
    resultLimit: integer(result.resultLimit, "result.resultLimit", { min: 1, max: 10, defaultValue: 8 }),
    results: results.map((item, index) => {
      const field = `result.results[${index}]`;
      const entry = object(item, field);
      const citationId = text(entry.citationId, `${field}.citationId`, { required: true, max: 200 });
      if (!/^(source:[0-9a-f-]+:entry:[0-9a-f-]+|homebrew:[0-9a-f-]+:revision:\d+|session:[0-9a-f-]+:intelligence:\d+)$/i.test(citationId)) {
        fail(`${field}.citationId is invalid`, `${field}.citationId`);
      }
      return {
        kind: enumValue(entry.kind, `${field}.kind`, ["source_entry", "homebrew", "session_recap"]),
        citationId,
        sourceId: uuid(entry.sourceId, `${field}.sourceId`),
        entryId: uuid(entry.entryId, `${field}.entryId`, true),
        name: text(entry.name, `${field}.name`, { required: true, max: 300 }),
        excerpt: text(entry.excerpt, `${field}.excerpt`, { max: 700 }),
        sourceName: text(entry.sourceName, `${field}.sourceName`, { required: true, max: 300 }),
        licenseType: text(entry.licenseType, `${field}.licenseType`, { required: true, max: 100 }),
        attributionText: text(entry.attributionText, `${field}.attributionText`, { max: 2_000 }),
        externalReferenceUrl: requireHttpsUrl(entry.externalReferenceUrl, `${field}.externalReferenceUrl`, false),
        contentOrigin: text(entry.contentOrigin, `${field}.contentOrigin`, { required: true, max: 100 }),
        rank: typeof entry.rank === "number" && Number.isFinite(entry.rank) ? entry.rank : 0,
      };
    }),
  };
}

export function retrievalCopyrightNotice() {
  return "Results are limited excerpts from campaign-authorized sources. Do not use retrieval to reconstruct or export source text.";
}
