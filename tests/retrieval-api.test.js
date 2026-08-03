import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { attachRetrievalRoutes } from "../src/retrieval-http.js";
import { withRetrievalStore } from "../src/retrieval-store.js";
import { withSessionIntelligenceStore } from "../src/session-intelligence-store.js";
import { MemoryCampaignStore } from "../src/store.js";

async function withServer(run) {
  const store = withRetrievalStore(withSessionIntelligenceStore(new MemoryCampaignStore()));
  const provider = new MockAiProvider();
  const server = createApp({ store, provider, corsOrigin: "*", rateLimit: { limit: 1_000 } });
  attachRetrievalRoutes(server, {
    store,
    corsOrigin: "*",
    rateLimit: { limit: 1_000 },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

async function createCampaign(baseUrl) {
  const created = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    body: JSON.stringify({ name: "Emberforge Rising" }),
  });
  assert.equal(created.status, 201);
  return created.body.campaign.id;
}

test("authorized retrieval creates a source, ingests content, and returns cited search results", async () => {
  await withServer(async (baseUrl) => {
    const campaignId = await createCampaign(baseUrl);
    const sourcesUrl = `${baseUrl}/api/v1/campaigns/${campaignId}/retrieval/sources`;
    const createdSource = await jsonRequest(sourcesUrl, {
      method: "POST",
      body: JSON.stringify({
        name: "Emberforge Campaign Notes",
        licenseType: "user_authored",
        fullTextAllowed: true,
        confirmedRightToUse: true,
        visibility: "campaign_members",
      }),
    });
    assert.equal(createdSource.status, 201);
    const sourceId = createdSource.body.source.id;

    const createdEntry = await jsonRequest(`${sourcesUrl}/${sourceId}/entries`, {
      method: "POST",
      body: JSON.stringify({
        contentType: "location",
        name: "The Ember Vault",
        summary: "A hidden vault beneath the lower forge.",
        fullText: "The Ember Vault contains ancestral runes and the damaged crucible.",
        contentOrigin: "user_authored",
        confirmedRightToUse: true,
        visibility: "inherit",
      }),
    });
    assert.equal(createdEntry.status, 201);
    assert.equal(createdEntry.body.entry.hasFullText, true);

    const listed = await jsonRequest(sourcesUrl);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.retrieval.sources[0].entryCount, 1);

    const searched = await jsonRequest(`${baseUrl}/api/v1/campaigns/${campaignId}/retrieval/search`, {
      method: "POST",
      body: JSON.stringify({ query: "ancestral crucible", limit: 5 }),
    });
    assert.equal(searched.status, 200);
    assert.equal(searched.body.retrieval.results.length, 1);
    assert.match(searched.body.retrieval.results[0].citationId, /^source:.+:entry:/);
    assert.ok(searched.body.retrieval.results[0].excerpt.length <= 700);
    assert.match(searched.body.notice, /limited excerpts/i);
  });
});

test("authorized retrieval rejects reconstruction searches and supports CORS preflight", async () => {
  await withServer(async (baseUrl) => {
    const campaignId = await createCampaign(baseUrl);
    const searchUrl = `${baseUrl}/api/v1/campaigns/${campaignId}/retrieval/search`;
    const rejected = await jsonRequest(searchUrl, {
      method: "POST",
      body: JSON.stringify({ query: "reconstruct the entire chapter" }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.field, "query");

    const preflight = await fetch(searchUrl, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
  });
});
