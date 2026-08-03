import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { attachProductionControlRoutes } from "../src/production-control-http.js";
import { withProductionControlStore } from "../src/production-control-store.js";
import { defaultGenerationPolicies, withProductionControls } from "../src/production-controls.js";
import { MemoryCampaignStore } from "../src/store.js";

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
}

async function withServer(run) {
  const raw = new MockAiProvider();
  const store = withProductionControlStore(new MemoryCampaignStore(), {
    defaultPolicies: defaultGenerationPolicies(raw.name, raw.model),
  });
  const provider = withProductionControls(raw, store);
  const server = createApp({ store, provider, corsOrigin: "*", rateLimit: { limit: 1000 } });
  attachProductionControlRoutes(server, { store, provider, corsOrigin: "*", serviceVersion: "0.10.0" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("health and production discovery expose versioned capabilities", async () => {
  await withServer(async (baseUrl) => {
    const health = await jsonRequest(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.version, "0.10.0");
    assert.equal(health.body.productionControls.rawPromptOutputStorage, false);
    assert.ok(health.body.capabilities.includes("dnd.production.budgets"));
    assert.match(health.headers.get("x-khaos-request-id"), /^[0-9a-f-]{36}$/i);

    const prompts = await jsonRequest(`${baseUrl}/api/v1/production/prompts`);
    assert.equal(prompts.status, 200);
    assert.match(prompts.body.promptRegistry.generateTurn.promptHash, /^[a-f0-9]{64}$/);
  });
});

test("HTTP budget blocks campaign generation and monitoring reports the decision", async () => {
  await withServer(async (baseUrl) => {
    const created = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST", body: JSON.stringify({ name: "Budget Test" }),
    });
    const campaignId = created.body.campaign.id;
    const budget = await jsonRequest(`${baseUrl}/api/v1/production/budgets`, {
      method: "POST",
      body: JSON.stringify({ campaignId, period: "daily", requestLimit: 0 }),
    });
    assert.equal(budget.status, 201);

    const blocked = await jsonRequest(`${baseUrl}/api/v1/campaigns/${campaignId}/turns`, {
      method: "POST", body: JSON.stringify({ actor: "Vorkesh", message: "Inspect the door" }),
    });
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /request_limit/i);

    const usage = await jsonRequest(`${baseUrl}/api/v1/production/usage?campaignId=${campaignId}`);
    assert.equal(usage.status, 200);
    assert.equal(usage.body.usage.summary.blocked, 1);
  });
});

test("manual evaluation returns deterministic report and optional persistence", async () => {
  await withServer(async (baseUrl) => {
    const response = await jsonRequest(`${baseUrl}/api/v1/production/evaluations`, {
      method: "POST",
      body: JSON.stringify({
        feature: "manual",
        categories: ["player_agency", "latency"],
        artifact: { output: "Choose how to respond.", latencyMs: 25 },
        persist: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.report.outcome, "pass");
    assert.match(response.body.artifactHash, /^[a-f0-9]{64}$/);
    assert.equal(response.body.persisted.outcome, "pass");
  });
});
