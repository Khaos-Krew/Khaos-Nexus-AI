import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { attachMapSceneRoutes } from "../src/map-scene-http.js";
import { withMapSceneStore } from "../src/map-scene-store.js";
import { MemoryCampaignStore } from "../src/store.js";

async function withServer(run) {
  const store = withMapSceneStore(new MemoryCampaignStore());
  const provider = new MockAiProvider();
  const server = createApp({ store, provider, corsOrigin: "*", rateLimit: { limit: 1_000 } });
  attachMapSceneRoutes(server, {
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

async function createCampaign(baseUrl) {
  const response = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    body: JSON.stringify({ name: "Emberforge Rising" }),
  });
  assert.equal(response.status, 201);
  return response.body.campaign.id;
}

function generationBody() {
  return {
    mapRequest: {
      mapType: "dungeon",
      prompt: "An ancestral forge vault with a hidden chamber",
      seed: "api-scene-seed",
      width: 28,
      height: 24,
      gridType: "square",
      scale: "5 feet",
      density: "standard",
      theme: "dark",
      biomes: ["forge"],
      features: ["vault", "gantry"],
      constraints: ["one hidden chamber"],
    },
    sceneOptions: {
      levelCount: 2,
      levelHeight: 15,
      defaultFogRevealed: false,
      includeLights: true,
      tokenMode: "encounters",
    },
  };
}

test("map scene API generates, saves, reads, approves, and exports", async () => {
  await withServer(async (baseUrl) => {
    const campaignId = await createCampaign(baseUrl);
    const root = `${baseUrl}/api/v1/campaigns/${campaignId}/map-scenes`;

    const generated = await jsonRequest(`${root}/generate`, {
      method: "POST",
      body: JSON.stringify(generationBody()),
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.gmScene.levels.length, 2);
    assert.equal(generated.body.playerScene.projection, "player");
    assert.match(generated.body.gmSvg, /^<svg/);
    assert.equal(generated.body.meta.persisted, false);

    const saved = await jsonRequest(root, {
      method: "POST",
      body: JSON.stringify({
        name: "The Ember Vault",
        sourceMap: generated.body.sourceMap,
        gmScene: generated.body.gmScene,
        playerScene: generated.body.playerScene,
        expectedRevision: 0,
      }),
    });
    assert.equal(saved.status, 201);
    const sceneId = saved.body.mapScene.scene.id;
    assert.equal(saved.body.mapScene.scene.revision, 1);

    const listed = await jsonRequest(root);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.mapScenes.scenes.length, 1);
    assert.equal(listed.body.mapScenes.scenes[0].levelCount, 2);

    const read = await jsonRequest(`${root}/${sceneId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.mapScene.scene.gmScene.projection, "gm");

    const approved = await jsonRequest(`${root}/${sceneId}/approve`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: 1 }),
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.mapScene.scene.approved, true);

    for (const target of ["khaos_scene", "universal_vtt_style", "foundry_scene_data"]) {
      const exported = await jsonRequest(`${root}/${sceneId}/export`, {
        method: "POST",
        body: JSON.stringify({ target, projection: "player" }),
      });
      assert.equal(exported.status, 200);
      assert.equal(exported.body.export.target, target);
      assert.equal(exported.body.export.hash.length, 64);
      assert.match(exported.body.export.filename, /-r1-player-/);
    }
  });
});

test("map scene API rejects source hash mismatches and supports preflight", async () => {
  await withServer(async (baseUrl) => {
    const campaignId = await createCampaign(baseUrl);
    const root = `${baseUrl}/api/v1/campaigns/${campaignId}/map-scenes`;
    const generated = await jsonRequest(`${root}/generate`, {
      method: "POST",
      body: JSON.stringify(generationBody()),
    });
    const mismatched = await jsonRequest(root, {
      method: "POST",
      body: JSON.stringify({
        name: "Mismatch",
        sourceMap: { ...generated.body.sourceMap, title: "Different" },
        gmScene: generated.body.gmScene,
        playerScene: generated.body.playerScene,
        expectedRevision: 0,
      }),
    });
    assert.equal(mismatched.status, 400);
    assert.equal(mismatched.body.field, "sourceMap");

    const preflight = await fetch(`${root}/generate`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
  });
});
