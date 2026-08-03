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

test("encounter API discovers tools, executes combat, and returns state", async () => {
  await withServer(async (baseUrl) => {
    const discovery = await jsonRequest(`${baseUrl}/api/v1/encounter-tools`);
    assert.equal(discovery.status, 200);
    assert.equal(discovery.body.tools.length, 16);

    const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify({ name: "Emberforge Rising" }),
    });
    const campaignId = campaign.body.campaign.id;

    const created = await jsonRequest(
      `${baseUrl}/api/v1/campaigns/${campaignId}/encounters/tools/execute`,
      {
        method: "POST",
        body: JSON.stringify({
          tool: "create_encounter",
          arguments: { name: "Ashen Crucible", status: "draft" },
        }),
      },
    );
    assert.equal(created.status, 200);
    const encounterId = created.body.execution.encounterId;

    const added = await jsonRequest(
      `${baseUrl}/api/v1/campaigns/${campaignId}/encounters/tools/execute`,
      {
        method: "POST",
        body: JSON.stringify({
          tool: "add_combatant",
          arguments: {
            encounterId,
            name: "Forge Tyrant",
            initiative: 17,
            dexterity: 12,
            hp: 30,
            maxHp: 30,
            tempHp: 4,
            armorClass: 18,
          },
        }),
      },
    );
    assert.equal(added.status, 200);
    const combatantId = added.body.execution.result.id;

    const damaged = await jsonRequest(
      `${baseUrl}/api/v1/campaigns/${campaignId}/encounters/tools/execute`,
      {
        method: "POST",
        body: JSON.stringify({
          tool: "apply_damage",
          arguments: { combatantId, amount: 9, damageType: "force" },
        }),
      },
    );
    assert.equal(damaged.status, 200);
    assert.equal(damaged.body.execution.result.tempHp, 0);
    assert.equal(damaged.body.execution.result.hp, 25);

    const state = await jsonRequest(
      `${baseUrl}/api/v1/campaigns/${campaignId}/encounters/${encounterId}`,
    );
    assert.equal(state.status, 200);
    assert.equal(state.body.encounter.encounter.name, "Ashen Crucible");
    assert.equal(state.body.encounter.combatants[0].id, combatantId);
  });
});

test("encounter API rejects incomplete visibility mutations", async () => {
  await withServer(async (baseUrl) => {
    const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify({ name: "Validation" }),
    });
    const response = await jsonRequest(
      `${baseUrl}/api/v1/campaigns/${campaign.body.campaign.id}/encounters/tools/execute`,
      {
        method: "POST",
        body: JSON.stringify({
          tool: "set_combatant_visibility",
          arguments: {
            combatantId: "11111111-1111-4111-8111-111111111111",
            hidden: true,
          },
        }),
      },
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.field, "arguments.active");
  });
});
