import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { withSessionIntelligence } from "../src/session-intelligence-provider.js";
import { attachSessionIntelligenceRoutes } from "../src/session-intelligence-http.js";
import { withSessionIntelligenceStore } from "../src/session-intelligence-store.js";
import { MemoryCampaignStore } from "../src/store.js";

const SESSION_ID = "22222222-2222-4222-8222-222222222222";

async function withServer(run) {
  const store = withSessionIntelligenceStore(new MemoryCampaignStore());
  const provider = withSessionIntelligence(new MockAiProvider());
  const server = createApp({ store, provider, corsOrigin: "*", rateLimit: { limit: 1_000 } });
  attachSessionIntelligenceRoutes(server, {
    store,
    provider,
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

async function createCampaignAndSession(baseUrl) {
  const created = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    body: JSON.stringify({ name: "Emberforge Rising" }),
  });
  assert.equal(created.status, 201);
  const campaignId = created.body.campaign.id;
  const session = await jsonRequest(`${baseUrl}/api/v1/campaigns/${campaignId}/tools/execute`, {
    method: "POST",
    body: JSON.stringify({
      tool: "upsert_session",
      arguments: {
        id: SESSION_ID,
        title: "The Broken Crucible",
        status: "completed",
        dmNotes: "The saboteur escaped through the lower tunnels.",
      },
    }),
  });
  assert.equal(session.status, 200);
  return campaignId;
}

test("session intelligence generates, saves, reads, and approves through HTTP", async () => {
  await withServer(async (baseUrl) => {
    const campaignId = await createCampaignAndSession(baseUrl);
    const root = `${baseUrl}/api/v1/campaigns/${campaignId}/sessions/${SESSION_ID}/intelligence`;

    const generated = await jsonRequest(`${root}/generate`, {
      method: "POST",
      body: JSON.stringify({
        sourceNotes: [
          "PUBLIC FACT: The crucible was damaged.",
          "SECRET: The warden caused the failure.",
          "PUBLIC THREAD: Repair the crucible.",
        ].join("\n"),
      }),
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.meta.persisted, false);
    assert.match(generated.body.result.gmRecap, /warden caused the failure/i);

    const saved = await jsonRequest(`${root}/save`, {
      method: "POST",
      body: JSON.stringify({ intelligence: generated.body.result, expectedRevision: 0 }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.intelligence.revision, 1);
    assert.equal(saved.body.intelligence.approved, false);

    const read = await jsonRequest(root);
    assert.equal(read.status, 200);
    assert.equal(read.body.intelligence.intelligence.sessionTitle, "The Broken Crucible");

    const approved = await jsonRequest(`${root}/approve`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.intelligence.approved, true);

    const stale = await jsonRequest(`${root}/save`, {
      method: "POST",
      body: JSON.stringify({ intelligence: generated.body.result, expectedRevision: 0 }),
    });
    assert.equal(stale.status, 409);
  });
});

test("session intelligence wrapper handles CORS preflight and strict inputs", async () => {
  await withServer(async (baseUrl) => {
    const campaignId = await createCampaignAndSession(baseUrl);
    const root = `${baseUrl}/api/v1/campaigns/${campaignId}/sessions/${SESSION_ID}/intelligence`;
    const preflight = await fetch(`${root}/generate`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);

    const invalid = await jsonRequest(`${root}/generate`, {
      method: "POST",
      body: JSON.stringify({ sourceNotes: "Notes", unknown: true }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.field, "body.unknown");
  });
});
