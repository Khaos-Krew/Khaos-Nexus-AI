import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import { createApp } from "../src/app.js";
import { LocalDiscordBridge } from "../src/discord-adapters.js";
import { attachDiscordRoutes } from "../src/discord-http.js";
import { LocalEncounterEngine } from "../src/encounter-engine.js";
import { withSessionIntelligence } from "../src/session-intelligence-provider.js";
import { withSessionIntelligenceStore } from "../src/session-intelligence-store.js";
import { MemoryCampaignStore } from "../src/store.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
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
  const store = withSessionIntelligenceStore(new MemoryCampaignStore());
  const provider = withSessionIntelligence(new MockAiProvider());
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

async function setup(baseUrl) {
  const campaign = await jsonRequest(`${baseUrl}/api/v1/campaigns`, {
    method: "POST",
    body: JSON.stringify({ name: "Emberforge Rising" }),
  });
  const campaignId = campaign.body.campaign.id;
  await jsonRequest(`${baseUrl}/api/v1/campaigns/${campaignId}/tools/execute`, {
    method: "POST",
    body: JSON.stringify({
      tool: "upsert_session",
      arguments: { id: SESSION_ID, title: "The Broken Crucible", status: "completed" },
    }),
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

test("Discord generates, saves, views, and approves session intelligence", async () => {
  await withServer(async (baseUrl) => {
    await setup(baseUrl);
    const generated = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("generate_session_intelligence", {
        sessionId: SESSION_ID,
        request: {
          sourceNotes: "PUBLIC FACT: The crucible was damaged.\nPUBLIC THREAD: Repair the crucible.",
        },
        persist: true,
        expectedRevision: 0,
      })),
    });
    assert.equal(generated.status, 200);
    assert.match(generated.body.discord.content, /revision \*\*1\*\*/);
    assert.equal(generated.body.discord.ephemeral, true);

    const viewed = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("session_intelligence", { sessionId: SESSION_ID })),
    });
    assert.equal(viewed.status, 200);
    assert.match(viewed.body.discord.content, /draft/);

    const approved = await jsonRequest(`${baseUrl}/api/v1/discord/commands`, {
      method: "POST",
      body: JSON.stringify(command("approve_session_intelligence", {
        sessionId: SESSION_ID,
        expectedRevision: 1,
      })),
    });
    assert.equal(approved.status, 200);
    assert.match(approved.body.discord.content, /Approved session intelligence/);
  });
});
