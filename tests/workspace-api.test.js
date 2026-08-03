import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MemoryCampaignStore } from "../src/store.js";

async function withServer(run) {
  const server = createApp({
    store: new MemoryCampaignStore(),
    provider: { name: "fake", model: "test" },
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
  return { status: response.status, body: await response.json() };
}

test("workspace tool API discovers the allow-list and executes a local NPC mutation", async () => {
  await withServer(async (baseUrl) => {
    const discovery = await jsonRequest(`${baseUrl}/api/v1/workspace-tools`);
    assert.equal(discovery.status, 200);
    assert.ok(discovery.body.tools.some((tool) => tool.name === "upsert_npc"));

    const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify({ name: "Emberforge Rising" }),
    });
    assert.equal(campaign.status, 201);
    const campaignId = campaign.body.campaign.id;

    const execution = await jsonRequest(`${baseUrl}/api/v1/campaigns/${campaignId}/tools/execute`, {
      method: "POST",
      body: JSON.stringify({
        tool: "upsert_npc",
        arguments: {
          name: "Ember Warden",
          publicSummary: "A guarded smith.",
          gmNotes: "Secretly serves the Crucible.",
          revealed: true,
        },
      }),
    });
    assert.equal(execution.status, 200);
    assert.equal(execution.body.execution.tool, "upsert_npc");
    assert.equal(execution.body.execution.record.name, "Ember Warden");

    const workspace = await jsonRequest(`${baseUrl}/api/v1/campaigns/${campaignId}/workspace`);
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.workspace.npcs.length, 1);
    assert.equal(workspace.body.workspace.npcs[0].revealed, true);
  });
});

test("workspace tool API rejects undeclared mutation fields", async () => {
  await withServer(async (baseUrl) => {
    const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify({ name: "Validation" }),
    });
    const response = await jsonRequest(
      `${baseUrl}/api/v1/campaigns/${campaign.body.campaign.id}/tools/execute`,
      {
        method: "POST",
        body: JSON.stringify({
          tool: "upsert_quest",
          arguments: { title: "Forbidden", approved: true },
        }),
      },
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.field, "arguments.approved");
  });
});
