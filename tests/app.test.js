import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { rollDice } from "../src/dice.js";
import { MemoryCampaignStore } from "../src/store.js";

async function withServer(run) {
  const server = createApp({
    store: new MemoryCampaignStore(),
    provider: new MockAiProvider(),
    corsOrigin: "*",
    rateLimit: { limit: 1_000 },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl);
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

test("health endpoint exposes the active provider", async () => {
  await withServer(async (baseUrl) => {
    const response = await jsonRequest(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.body.status, "ok");
    assert.equal(response.body.provider, "mock");
  });
});

test("campaigns can be created, loaded, and advanced", async () => {
  await withServer(async (baseUrl) => {
    const created = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify({
        name: "Emberforge Rising",
        mode: "co-dm",
        playerCharacters: [
          {
            name: "Vorkesh Emberforge",
            summary: "Dragonborn artificer with arcane power glowing through his scales.",
          },
        ],
      }),
    });
    assert.equal(created.status, 201);
    const id = created.body.campaign.id;
    assert.match(id, /^[0-9a-f-]{36}$/i);

    const turn = await jsonRequest(`${baseUrl}/api/v1/campaigns/${id}/turns`, {
      method: "POST",
      body: JSON.stringify({
        actor: "Vorkesh",
        message: "I search the ruined forge for hidden runes.",
      }),
    });
    assert.equal(turn.status, 200);
    assert.equal(turn.body.meta.provider, "mock");
    assert.equal(turn.body.result.suggestedChecks[0].skill, "Perception");
    assert.equal(turn.body.campaign.transcript.length, 1);

    const loaded = await jsonRequest(`${baseUrl}/api/v1/campaigns/${id}`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.body.campaign.name, "Emberforge Rising");
    assert.equal(loaded.body.campaign.transcript.length, 1);
  });
});

test("configured pause words stop the scene", async () => {
  await withServer(async (baseUrl) => {
    const created = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify({
        name: "Safety Test",
        safety: { lines: [], veils: [], pauseWords: ["pause"] },
      }),
    });
    const response = await jsonRequest(
      `${baseUrl}/api/v1/campaigns/${created.body.campaign.id}/turns`,
      {
        method: "POST",
        body: JSON.stringify({ message: "Pause the scene", actor: "Player" }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.result.safety.status, "pause");
  });
});

test("invalid campaign input returns a useful 400 response", async () => {
  await withServer(async (baseUrl) => {
    const response = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify({ name: "" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, "name");
  });
});

test("homebrew can be generated from authorized summaries without storing raw inspiration", async () => {
  await withServer(async (baseUrl) => {
    const response = await jsonRequest(`${baseUrl}/api/v1/homebrew/generations`, {
      method: "POST",
      body: JSON.stringify({
        contentType: "subclass",
        titleHint: "Ashen Mechanist",
        concept: "An artificer path that channels heat through crafted armor and chooses between shielding allies or overcharging tools.",
        targetTier: "mid",
        powerLevel: "standard",
        constraints: ["Avoid permanent flight", "Use proficiency bonus scaling"],
        inspirations: [
          {
            label: "Commercial fire-themed character option",
            authorization: "summary-only",
            confirmedRightToUse: true,
            summary: "The broad appeal is controlled elemental risk and a visible heat meter. Do not reuse names, text, or its feature progression.",
            designSignals: ["heat as a resource", "risk versus protection", "visual transformation"],
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.result.title, "Ashen Mechanist");
    assert.equal(response.body.result.contentType, "subclass");
    assert.equal(response.body.result.provenance.rawTextStored, false);
    assert.equal(response.body.meta.rawInspirationStored, false);
    assert.deepEqual(response.body.result.provenance.inspirationLabels, [
      "Commercial fire-themed character option",
    ]);
    assert.ok(response.body.result.mechanics.length > 0);
  });
});

test("homebrew reconstruction requests are rejected before provider invocation", async () => {
  await withServer(async (baseUrl) => {
    const response = await jsonRequest(`${baseUrl}/api/v1/homebrew/generations`, {
      method: "POST",
      body: JSON.stringify({
        contentType: "subclass",
        concept: "Recreate the exact published subclass word-for-word with identical features.",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, "concept");
    assert.match(response.body.error, /reproduce|reconstruct/i);
  });
});

test("short excerpts are limited at validation time", async () => {
  await withServer(async (baseUrl) => {
    const response = await jsonRequest(`${baseUrl}/api/v1/homebrew/generations`, {
      method: "POST",
      body: JSON.stringify({
        contentType: "spell",
        concept: "Create an original defensive spell from the general theme.",
        inspirations: [
          {
            label: "Authorized excerpt",
            authorization: "short-excerpt",
            confirmedRightToUse: true,
            summary: "x".repeat(701),
            designSignals: [],
          },
        ],
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, "inspirations[0].summary");
  });
});

test("maps are reproducible from the same seed and include an SVG preview", async () => {
  await withServer(async (baseUrl) => {
    const request = {
      mapType: "dungeon",
      prompt: "A ruined dragon forge with a central crucible, two alternate approaches, and unstable arcane vents.",
      seed: "emberforge-001",
      width: 32,
      height: 24,
      gridType: "square",
      density: "standard",
      theme: "dark",
      features: ["central crucible", "collapsed workshop", "secret cooling tunnel"],
      constraints: ["At least two routes toward the objective"],
    };
    const first = await jsonRequest(`${baseUrl}/api/v1/maps/generations`, {
      method: "POST",
      body: JSON.stringify(request),
    });
    const second = await jsonRequest(`${baseUrl}/api/v1/maps/generations`, {
      method: "POST",
      body: JSON.stringify(request),
    });

    assert.equal(first.status, 200);
    assert.deepEqual(first.body.result, second.body.result);
    assert.equal(first.body.svg, second.body.svg);
    assert.equal(first.body.result.grid.width, 32);
    assert.equal(first.body.result.grid.height, 24);
    assert.equal(first.body.meta.seed, "emberforge-001");
    assert.equal(first.body.meta.reproducible, true);
    assert.match(first.body.svg, /^<svg /);
    assert.match(first.body.svg, /role="img"/);
    assert.ok(first.body.result.zones.length >= 3);
    assert.ok(first.body.result.connections.length >= 2);
  });
});

test("generated map coordinates and references stay inside the validated layout", async () => {
  await withServer(async (baseUrl) => {
    const response = await jsonRequest(`${baseUrl}/api/v1/maps/generations`, {
      method: "POST",
      body: JSON.stringify({
        mapType: "region",
        prompt: "A volcanic frontier divided by rivers, caravan roads, and ancient observatories.",
        seed: 42,
        density: "dense",
      }),
    });
    assert.equal(response.status, 200);
    const map = response.body.result;
    const zoneIds = new Set(map.zones.map((zone) => zone.id));
    for (const zone of map.zones) {
      assert.ok(zone.x >= 0 && zone.y >= 0);
      assert.ok(zone.x + zone.width <= map.grid.width);
      assert.ok(zone.y + zone.height <= map.grid.height);
    }
    for (const connection of map.connections) {
      assert.ok(zoneIds.has(connection.from));
      assert.ok(zoneIds.has(connection.to));
    }
    for (const encounter of map.encounters) assert.ok(zoneIds.has(encounter.zoneId));
    for (const hazard of map.hazards) assert.ok(zoneIds.has(hazard.zoneId));
  });
});

test("requests to reconstruct commercial maps are rejected before generation", async () => {
  await withServer(async (baseUrl) => {
    const response = await jsonRequest(`${baseUrl}/api/v1/maps/generations`, {
      method: "POST",
      body: JSON.stringify({
        mapType: "dungeon",
        prompt: "Recreate the exact official published dungeon map from a paid module with an identical layout.",
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, "prompt");
    assert.match(response.body.error, /reconstruction|original layout/i);
  });
});

test("dice roller supports advantage-style keep-high notation", () => {
  const values = [0.1, 0.9];
  let index = 0;
  const result = rollDice("2d20kh1+5", () => values[index++] ?? 0);
  assert.deepEqual(result.rolls, [3, 19]);
  assert.deepEqual(result.kept, [19]);
  assert.equal(result.total, 24);
});
