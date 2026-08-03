import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { LocalDiscordBridge } from "../src/discord-adapters.js";
import { attachDiscordRoutes } from "../src/discord-http.js";
import { attachDiscordSecurity } from "../src/discord-security.js";
import { LocalEncounterEngine } from "../src/encounter-engine.js";
import { MemoryCampaignStore } from "../src/store.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const GUILD_ID = "123456789012345678";
const CHANNEL_ID = "223456789012345678";
const DISCORD_USER_ID = "323456789012345678";

async function withServer(run, security = {}) {
  const store = new MemoryCampaignStore();
  const provider = { name: "fake", model: "test" };
  const discordBridge = new LocalDiscordBridge();
  const encounterEngine = new LocalEncounterEngine();
  const server = createApp({
    store,
    provider,
    encounterEngine,
    corsOrigin: "*",
    rateLimit: { limit: 1_000 },
  });
  attachDiscordRoutes(server, {
    store,
    provider,
    discordBridge,
    encounterEngine,
    corsOrigin: "*",
  });
  attachDiscordSecurity(server, { corsOrigin: "*", ...security });
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
  const body = response.status === 204 ? null : await response.json();
  return { status: response.status, body };
}

async function createVerifiedBinding(baseUrl) {
  const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    body: JSON.stringify({ name: "Emberforge Rising" }),
  });
  const campaignId = campaign.body.campaign.id;
  const created = await jsonRequest(
    `${baseUrl}/api/v1/campaigns/${campaignId}/discord/bindings`,
    {
      method: "POST",
      body: JSON.stringify({
        registeredAppId: APP_ID,
        guildId: GUILD_ID,
        resourceType: "channel",
        resourceId: CHANNEL_ID,
        displayName: "dnd-campaign",
        purpose: "main",
        isPrimary: true,
      }),
    },
  );
  assert.equal(created.status, 201);
  const bindingId = created.body.binding.id;
  const verified = await jsonRequest(
    `${baseUrl}/api/v1/campaigns/${campaignId}/discord/bindings/${bindingId}/verify`,
    {
      method: "POST",
      body: JSON.stringify({ verified: true }),
    },
  );
  assert.equal(verified.status, 200);
  return { campaignId, bindingId };
}

test("Discord bridge binds existing channels and renders status and dice responses", async () => {
  await withServer(async (baseUrl) => {
    const { campaignId } = await createVerifiedBinding(baseUrl);

    const discovery = await jsonRequest(`${baseUrl}/api/v1/discord/commands`);
    assert.equal(discovery.status, 200);
    assert.equal(discovery.body.commands.length, 11);

    const status = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify({
        registeredAppId: APP_ID,
        guildId: GUILD_ID,
        resourceId: CHANNEL_ID,
        discordUserId: DISCORD_USER_ID,
        command: "campaign_status",
        options: {},
      }),
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.context.campaignId, campaignId);
    assert.match(status.body.discord.content, /Emberforge Rising/);

    const roll = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify({
        registeredAppId: APP_ID,
        guildId: GUILD_ID,
        resourceId: CHANNEL_ID,
        discordUserId: DISCORD_USER_ID,
        command: "roll",
        options: { notation: "1d20+5" },
      }),
    });
    assert.equal(roll.status, 200);
    assert.match(roll.body.discord.content, /1d20\+5/);
  });
});

test("Discord commands reject unverified resources", async () => {
  await withServer(async (baseUrl) => {
    const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
      method: "POST",
      body: JSON.stringify({ name: "Unverified" }),
    });
    await jsonRequest(
      `${baseUrl}/api/v1/campaigns/${campaign.body.campaign.id}/discord/bindings`,
      {
        method: "POST",
        body: JSON.stringify({
          registeredAppId: APP_ID,
          guildId: GUILD_ID,
          resourceId: CHANNEL_ID,
          purpose: "main",
        }),
      },
    );
    const response = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify({
        registeredAppId: APP_ID,
        guildId: GUILD_ID,
        resourceId: CHANNEL_ID,
        discordUserId: DISCORD_USER_ID,
        command: "campaign_status",
        options: {},
      }),
    });
    assert.equal(response.status, 404);
  });
});

test("Discord wrapper handles CORS preflight and independent rate limiting", async () => {
  await withServer(async (baseUrl) => {
    const preflight = await fetch(`${baseUrl}/api/v1/discord/commands`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);

    const first = await jsonRequest(`${baseUrl}/api/v1/discord/commands`);
    assert.equal(first.status, 200);
    const second = await jsonRequest(`${baseUrl}/api/v1/discord/commands`);
    assert.equal(second.status, 429);
  }, { limit: 1 });
});
