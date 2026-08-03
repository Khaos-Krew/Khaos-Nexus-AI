import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { withCoDmDraft } from "../src/co-dm.js";
import { attachCoDmRoutes } from "../src/co-dm-http.js";
import { attachProductionControlRoutes } from "../src/production-control-http.js";
import { withProductionControlStore } from "../src/production-control-store.js";
import { defaultGenerationPolicies, withProductionControls } from "../src/production-controls.js";
import { MemoryCampaignStore } from "../src/store.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function body(overrides = {}) {
  return {
    apiVersion: "1",
    requestId: REQUEST_ID,
    workflow: "session_prep",
    model: "default",
    prompt: "Prepare the next session.",
    context: {
      campaignId: "local-opaque-id",
      campaignName: "Emberfall",
      characters: 5000,
      sections: [{ id: "characters", label: "Characters", count: 4, reason: "included" }],
      text: "The heroes returned to the forge.",
    },
    limits: { maxOutputCharacters: 40000 },
    policy: {
      explicitUserAction: true,
      autonomousActionsAllowed: false,
      providerStorageAllowed: false,
      toolsAllowed: false,
      licensedFullTextProvided: false,
    },
    ...overrides,
  };
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
}

async function withServer(run) {
  const raw = withCoDmDraft(new MockAiProvider());
  const store = withProductionControlStore(new MemoryCampaignStore(), {
    defaultPolicies: defaultGenerationPolicies(raw.name, raw.model),
  });
  const provider = withProductionControls(raw, store);
  const server = createApp({ store, provider, corsOrigin: "*", rateLimit: { limit: 1000 } });
  attachCoDmRoutes(server, { store, provider, corsOrigin: "*", rateLimit: { limit: 1000 } });
  attachProductionControlRoutes(server, { store, provider, corsOrigin: "*", serviceVersion: "0.11.0" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`, store); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("health advertises the dedicated desktop Co-DM capability", async () => {
  await withServer(async (baseUrl) => {
    const health = await jsonRequest(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.version, "0.11.0");
    assert.ok(health.body.capabilities.includes("dnd.co-dm.draft"));
  });
});

test("desktop Co-DM endpoint returns a stateless review draft without campaigns", async () => {
  await withServer(async (baseUrl) => {
    const before = await jsonRequest(`${baseUrl}/api/v1/campaigns`);
    const response = await jsonRequest(`${baseUrl}/api/v1/dnd/co-dm/drafts`, {
      method: "POST",
      headers: { "X-Khaos-Request-Id": REQUEST_ID },
      body: JSON.stringify(body()),
    });
    const after = await jsonRequest(`${baseUrl}/api/v1/campaigns`);
    assert.equal(response.status, 200);
    assert.equal(response.body.apiVersion, "1");
    assert.equal(response.body.requestId, REQUEST_ID);
    assert.equal(response.body.draft.workflow, "session_prep");
    assert.equal(response.body.draft.model, "mock/deterministic-local");
    assert.match(response.body.draft.content, /stateless review draft/i);
    assert.deepEqual(response.body.usage, { inputTokens: 0, outputTokens: 0 });
    assert.equal(response.headers.get("x-khaos-request-id"), REQUEST_ID);
    assert.equal(before.body.campaigns.length, 0);
    assert.equal(after.body.campaigns.length, 0);
  });
});

test("request IDs and privacy flags are enforced with safe errors", async () => {
  await withServer(async (baseUrl) => {
    const mismatch = await jsonRequest(`${baseUrl}/api/v1/dnd/co-dm/drafts`, {
      method: "POST",
      headers: { "X-Khaos-Request-Id": "22222222-2222-4222-8222-222222222222" },
      body: JSON.stringify(body()),
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, "INVALID_REQUEST");
    assert.equal(mismatch.body.error.retryable, false);

    const tools = await jsonRequest(`${baseUrl}/api/v1/dnd/co-dm/drafts`, {
      method: "POST",
      headers: { "X-Khaos-Request-Id": REQUEST_ID },
      body: JSON.stringify(body({ policy: { ...body().policy, toolsAllowed: true } })),
    });
    assert.equal(tools.status, 400);
    assert.doesNotMatch(JSON.stringify(tools.body), /api key|provider credential/i);
  });
});

test("Co-DM budgets block generation before the draft provider runs", async () => {
  await withServer(async (baseUrl, store) => {
    await store.upsertProductionBudget({ feature: "co_dm.draft", period: "daily", requestLimit: 0 });
    const response = await jsonRequest(`${baseUrl}/api/v1/dnd/co-dm/drafts`, {
      method: "POST",
      headers: { "X-Khaos-Request-Id": REQUEST_ID },
      body: JSON.stringify(body()),
    });
    assert.equal(response.status, 429);
    assert.equal(response.body.error.code, "RATE_LIMITED");
    const usage = await store.listProductionUsage(null, 10);
    assert.equal(usage.summary.blocked, 1);
  });
});
