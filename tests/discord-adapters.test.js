import assert from "node:assert/strict";
import test from "node:test";
import { LocalDiscordBridge, SupabaseDiscordBridge } from "../src/discord-adapters.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const APP_ID = "22222222-2222-4222-8222-222222222222";
const BINDING_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN = "header.payload.signature-value-long-enough";

const bindingInput = {
  bindingId: null,
  registeredAppId: APP_ID,
  guildId: "123456789012345678",
  resourceType: "channel",
  resourceId: "223456789012345678",
  parentChannelId: null,
  displayName: "dnd-campaign",
  purpose: "main",
  isPrimary: true,
  active: true,
};

test("local Discord bindings must be verified before command context resolves", async () => {
  const bridge = new LocalDiscordBridge();
  const binding = await bridge.upsertBinding(CAMPAIGN_ID, bindingInput);
  await assert.rejects(
    () => bridge.resolveContext({
      registeredAppId: APP_ID,
      guildId: binding.guildId,
      resourceId: binding.resourceId,
      discordUserId: "323456789012345678",
    }),
    /verified campaign binding/i,
  );

  await bridge.verifyBinding(CAMPAIGN_ID, binding.id, { verified: true, errorCode: "" });
  const context = await bridge.resolveContext({
    registeredAppId: APP_ID,
    guildId: binding.guildId,
    resourceId: binding.resourceId,
    discordUserId: "323456789012345678",
  });
  assert.equal(context.campaignId, CAMPAIGN_ID);
  assert.equal(context.canManage, true);
  assert.equal(context.member.discordUserId, "323456789012345678");
});

test("Supabase Discord adapter forwards caller JWT and exact binding arguments", async () => {
  let captured;
  const bridge = new SupabaseDiscordBridge({
    async rpc(name, args, token) {
      captured = { name, args, token };
      return { id: BINDING_ID };
    },
  });
  const auth = { token: TOKEN, user: { id: USER_ID } };
  await bridge.upsertBinding(CAMPAIGN_ID, bindingInput, auth);

  assert.equal(captured.name, "dnd_ai_upsert_discord_binding");
  assert.equal(captured.args.p_campaign_id, CAMPAIGN_ID);
  assert.equal(captured.args.p_registered_app_id, APP_ID);
  assert.equal(captured.args.p_resource_id, bindingInput.resourceId);
  assert.equal(captured.token, TOKEN);
});

test("Supabase Discord command context is resolved using the linked actor", async () => {
  let captured;
  const bridge = new SupabaseDiscordBridge({
    async rpc(name, args, token) {
      captured = { name, args, token };
      return { campaignId: CAMPAIGN_ID, canManage: false };
    },
  });
  const auth = { token: TOKEN, user: { id: USER_ID } };
  const result = await bridge.resolveContext({
    registeredAppId: APP_ID,
    guildId: "123456789012345678",
    resourceId: "223456789012345678",
    discordUserId: "323456789012345678",
  }, auth);

  assert.equal(result.campaignId, CAMPAIGN_ID);
  assert.equal(captured.name, "dnd_ai_discord_context");
  assert.equal(captured.args.p_discord_user_id, "323456789012345678");
  assert.equal(captured.token, TOKEN);
});
