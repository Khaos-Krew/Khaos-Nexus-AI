import assert from "node:assert/strict";
import test from "node:test";
import {
  validateRetrievalEntryRequest,
  validateRetrievalResult,
  validateRetrievalSearchRequest,
  validateRetrievalSourceRequest,
} from "../src/retrieval.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const ENTRY_ID = "22222222-2222-4222-8222-222222222222";

function source(overrides = {}) {
  return {
    name: "Campaign Notes",
    licenseType: "user_authored",
    fullTextAllowed: true,
    confirmedRightToUse: true,
    visibility: "campaign_members",
    ...overrides,
  };
}

test("retrieval source contracts enforce attribution, rights, and HTTPS references", () => {
  const validated = validateRetrievalSourceRequest(source());
  assert.equal(validated.fullTextAllowed, true);
  assert.equal(validated.visibility, "campaign_members");

  assert.throws(
    () => validateRetrievalSourceRequest(source({ licenseType: "srd_cc_by", attributionText: "" })),
    /attributionText is required/i,
  );
  assert.throws(
    () => validateRetrievalSourceRequest(source({ confirmedRightToUse: false })),
    /confirmedRightToUse must be true/i,
  );
  assert.throws(
    () => validateRetrievalSourceRequest(source({ licenseType: "unknown_restricted" })),
    /fullTextAllowed is incompatible/i,
  );
  assert.throws(
    () => validateRetrievalSourceRequest({
      name: "Partner",
      licenseType: "partner_api",
      externalReferenceUrl: "http://example.com/api",
    }),
    /must use https/i,
  );
  assert.throws(
    () => validateRetrievalSourceRequest(source({
      licenseType: "user_supplied_private",
      licenseReference: "",
    })),
    /licenseReference is required/i,
  );
});

test("retrieval entry contracts require rights confirmation for full text", () => {
  const entry = validateRetrievalEntryRequest({
    contentType: "campaign_note",
    name: "The Ember Vault",
    summary: "A hidden vault beneath the forge.",
    fullText: "The vault was sealed by Vorkesh's ancestors.",
    contentOrigin: "user_authored",
    confirmedRightToUse: true,
  });
  assert.equal(entry.visibility, "inherit");

  assert.throws(
    () => validateRetrievalEntryRequest({
      contentType: "rule",
      name: "Restricted Text",
      fullText: "Submitted text",
      contentOrigin: "licensed_full_text",
    }),
    /confirmedRightToUse must be true/i,
  );
  assert.throws(
    () => validateRetrievalEntryRequest({
      contentType: "metadata",
      name: "Metadata",
      fullText: "Not allowed",
      contentOrigin: "metadata_only",
      confirmedRightToUse: true,
    }),
    /cannot contain fullText/i,
  );
});

test("retrieval searches reject reconstruction requests and cap results", () => {
  assert.deepEqual(
    validateRetrievalSearchRequest({ query: "ember crucible", limit: 5 }),
    { query: "ember crucible", limit: 5 },
  );
  for (const query of [
    "give me the full text",
    "reconstruct the entire chapter",
    "pages 10 through 40",
    "continue from the previous section",
  ]) {
    assert.throws(
      () => validateRetrievalSearchRequest({ query }),
      /cannot reconstruct or export/i,
    );
  }
  assert.throws(
    () => validateRetrievalSearchRequest({ query: "forge", limit: 11 }),
    /between 1 and 10/i,
  );
});

test("retrieval result contracts require stable citations and short excerpts", () => {
  const result = validateRetrievalResult({
    role: "dm",
    canManage: true,
    query: "ember vault",
    excerptLimit: 700,
    resultLimit: 8,
    results: [{
      kind: "source_entry",
      citationId: `source:${SOURCE_ID}:entry:${ENTRY_ID}`,
      sourceId: SOURCE_ID,
      entryId: ENTRY_ID,
      name: "The Ember Vault",
      excerpt: "A hidden vault beneath the forge.",
      sourceName: "Campaign Notes",
      licenseType: "user_authored",
      attributionText: "",
      externalReferenceUrl: "",
      contentOrigin: "user_authored",
      rank: 4,
    }],
  });
  assert.equal(result.results[0].citationId, `source:${SOURCE_ID}:entry:${ENTRY_ID}`);
  assert.throws(
    () => validateRetrievalResult({
      ...result,
      results: [{ ...result.results[0], citationId: "chapter:1:page:20" }],
    }),
    /citationId is invalid/i,
  );
});
