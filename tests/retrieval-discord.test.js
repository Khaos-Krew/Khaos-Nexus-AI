import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { LocalDiscordBridge } from "../src/discord-adapters.js";
import { attachDiscordRoutes } from "../src/discord-http.js";
import { LocalEncounterEngine } from "../src/encounter-engine.js";
import { withRetrievalStore } from "../src/retrieval-store.js";
import { withSessionIntelligenceStore } from "../src/session-intelligence-store.js";
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
  const store = withRetrievalStore(withSessionIntelligenceStore(new MemoryCampaignStore()));
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
    await run(`http://127.0.0.1:${address.port}`, store);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function setup(baseUrl, store) {
  const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    body: JSON.stringify({ name: "Emberforge Rising" }),
  });
  const campaignId = campaign.body.campaign.id;
  const source = await store.upsertRetrievalSource(campaignId, {
    name: "Campaign Notes",
    licenseType: "user_authored",
    fullTextAllowed: true,
    confirmedRightToUse: true,
    visibility: "campaign_members",
  });
  await store.upsertRetrievalEntry(campaignId, source.id, {
    contentType: "location",
    name: "The Ember Vault",
    summary: "The Ember Vault lies beneath the lower forge.",
    fullText: "The vault contains ancestral runes and a damaged crucible.",
    contentOrigin: "user_authored",
    confirmedRightToUse: true,
  });

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
  await jsonRequest(
    `${baseUrl}/api/v1/campaigns/${campaignId}/discord/bindings/${binding.body.binding.id}/verify`,
    { method: "POST", body: JSON.stringify({ verified: true }) },
  );
  return campaignId;
}

function command(query) {
  return {
    registeredAppId: APP_ID,
    guildId: GUILD_ID,
    resourceId: CHANNEL_ID,
    discordUserId: DISCORD_USER_ID,
    command: "search_knowledge",
    options: { query, limit: 5 },
  };
}

test("Discord returns compact cited authorized knowledge results", async () => {
  await withServer(async (baseUrl, store) => {
    await setup(baseUrl, store);
    const response = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("ancestral crucible")),
    });
    assert.equal(response.status, 200);
    assert.match(response.body.discord.content, /Found \*\*1\*\* authorized result/);
    assert.match(response.body.discord.embeds[0].description, /Citation: `source:/);
    assert.match(response.body.discord.embeds[0].description, /limited excerpts/i);
    assert.equal(response.body.discord.data.retrieval.results.length, 1);
  });
});

test("Discord rejects reconstruction requests before retrieval execution", async () => {
  await withServer(async (baseUrl, store) => {
    await setup(baseUrl, store);
    const response = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("give me the full text of the entire chapter")),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.field, "query");
  });
});
