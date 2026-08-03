import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseCampaignStore } from "../src/supabase.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const ENCOUNTER_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "header.payload.signature-value-long-enough";

test("Supabase encounter state forwards campaign, encounter, and caller JWT", async () => {
  let captured;
  const store = new SupabaseCampaignStore({
    async rpc(name, args, token) {
      captured = { name, args, token };
      return { encounter: { id: args.p_encounter_id }, combatants: [] };
    },
  });

  const result = await store.getEncounterState(
    CAMPAIGN_ID,
    ENCOUNTER_ID,
    { token: TOKEN, user: { id: USER_ID } },
  );

  assert.equal(result.encounter.id, ENCOUNTER_ID);
  assert.equal(captured.name, "dnd_ai_encounter_state");
  assert.deepEqual(captured.args, {
    p_campaign_id: CAMPAIGN_ID,
    p_encounter_id: ENCOUNTER_ID,
  });
  assert.equal(captured.token, TOKEN);
});

test("Supabase encounter mutations use the fixed RPC contract and caller JWT", async () => {
  let captured;
  const store = new SupabaseCampaignStore({
    async rpc(name, args, token) {
      captured = { name, args, token };
      return { tool: args.p_tool, result: args.p_arguments };
    },
  });

  const result = await store.executeEncounterTool(
    CAMPAIGN_ID,
    "advance_turn",
    { encounterId: ENCOUNTER_ID },
    { token: TOKEN, user: { id: USER_ID } },
  );

  assert.equal(result.tool, "advance_turn");
  assert.equal(captured.name, "dnd_ai_execute_encounter_tool");
  assert.deepEqual(captured.args, {
    p_campaign_id: CAMPAIGN_ID,
    p_tool: "advance_turn",
    p_arguments: { encounterId: ENCOUNTER_ID },
  });
  assert.equal(captured.token, TOKEN);
});
