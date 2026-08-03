import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { LocalDiscordBridge } from "../src/discord-adapters.js";
import { attachDiscordRoutes } from "../src/discord-http.js";
import { LocalEncounterEngine } from "../src/encounter-engine.js";
import { withMapSceneStore } from "../src/map-scene-store.js";
import { MemoryCampaignStore } from "../src/store.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";
const DISCORD_USER_ID = "323456789012345678";

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

async function withServer(run) {
  const store = withMapSceneStore(new MemoryCampaignStore());
  const provider = new MockAiProvider();
  const discordBridge = new LocalDiscordBridge();
  const encounterEngine = new LocalEncounterEngine();
  const server = createApp({ store, provider, encounterEngine, corsOrigin: "*" });
  attachDiscordRoutes(server, {
    store,
    provider,
    discordBridge,
    encounterEngine,
    corsOrigin: "*",
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

function command(commandName, options) {
  return {
    registeredAppId: APP_ID,
    guildId: GUILD_ID,
    resourceId: CHANNEL_ID,
    discordUserId: DISCORD_USER_ID,
    command: commandName,
    options,
  };
}

async function setup(baseUrl) {
  const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    body: JSON.stringify({ name: "Emberforge Rising" }),
  });
  assert.equal(campaign.status, 201);
  const campaignId = campaign.body.campaign.id;
  const binding = await jsonRequest(`${baseUrl}/api/v1/campaigns/${campaignId}/discord/bindings`, {
    method: "POST",
    body: JSON.stringify({
      registeredAppId: APP_ID,
      guildId: GUILD_ID,
      resourceId: CHANNEL_ID,
      purpose: "main",
      isPrimary: true,
    }),
  });
  assert.equal(binding.status, 201);
  const verified = await jsonRequest(
    `${baseUrl}/api/v1/campaigns/${campaignId}/discord/bindings/${binding.body.binding.id}/verify`,
    { method: "POST", body: JSON.stringify({ verified: true }) },
  );
  assert.equal(verified.status, 200);
  return campaignId;
}

function mapRequest() {
  return {
    mapType: "dungeon",
    prompt: "An ancestral forge vault with a hidden chamber",
    seed: "discord-map-scene",
    width: 28,
    height: 24,
    gridType: "square",
    scale: "5 feet",
    density: "standard",
    theme: "dark",
    biomes: ["forge"],
    features: ["vault", "gantry"],
    constraints: ["one hidden chamber"],
  };
}

test("Discord generates, persists, approves, views, and exports map scenes", async () => {
  await withServer(async (baseUrl) => {
    await setup(baseUrl);
    const generated = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("generate_map_scene", {
        mapRequest: mapRequest(),
        sceneOptions: { levelCount: 2, levelHeight: 15 },
        persist: true,
        name: "The Ember Vault",
        expectedRevision: 0,
      })),
    });
    assert.equal(generated.status, 200);
    assert.equal(generated.body.discord.ephemeral, true);
    assert.match(generated.body.discord.content, /saved as revision \*\*1\*\*/i);
    const sceneId = generated.body.discord.data.record.scene.id;

    const viewed = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("map_scene", { sceneId })),
    });
    assert.equal(viewed.status, 200);
    assert.equal(viewed.body.discord.data.record.scene.gmScene.projection, "gm");
    assert.match(viewed.body.discord.data.svg, /^<svg/);

    const approved = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("approve_map_scene", {
        sceneId,
        expectedRevision: 1,
      })),
    });
    assert.equal(approved.status, 200);
    assert.match(approved.body.discord.content, /Approved map scene revision \*\*1\*\*/i);

    const exported = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("export_map_scene", {
        sceneId,
        target: "foundry_scene_data",
        projection: "player",
      })),
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.discord.data.export.target, "foundry_scene_data");
    assert.equal(exported.body.discord.data.export.projection, "player");
    assert.equal(exported.body.discord.data.export.hash.length, 64);
    assert.match(exported.body.discord.content, /Export ready/i);
  });
});

test("Discord requires exact map scene revisions", async () => {
  await withServer(async (baseUrl) => {
    await setup(baseUrl);
    const generated = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("generate_map_scene", {
        mapRequest: mapRequest(),
        sceneOptions: {},
        persist: true,
        expectedRevision: 0,
      })),
    });
    const sceneId = generated.body.discord.data.record.scene.id;
    const stale = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("approve_map_scene", {
        sceneId,
        expectedRevision: 2,
      })),
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /reload before approving/i);
  });
});
