import assert from "node:assert/strict";
import test from "node:test";
import { SupabaseCampaignStore } from "../src/supabase.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "header.payload.signature-value-long-enough";

test("Supabase workspace tool execution forwards the user JWT and fixed RPC arguments", async () => {
  let captured;
  const store = new SupabaseCampaignStore({
    async rpc(name, args, token) {
      captured = { name, args, token };
      return { tool: args.p_tool, record: { id: USER_ID, name: args.p_arguments.name } };
    },
  });

  const result = await store.executeWorkspaceTool(
    CAMPAIGN_ID,
    "upsert_npc",
    { name: "Ember Warden", revealed: false },
    { token: TOKEN, user: { id: USER_ID } },
  );

  assert.equal(result.tool, "upsert_npc");
  assert.equal(captured.name, "dnd_ai_execute_workspace_tool");
  assert.equal(captured.args.p_campaign_id, CAMPAIGN_ID);
  assert.equal(captured.args.p_tool, "upsert_npc");
  assert.deepEqual(captured.args.p_arguments, { name: "Ember Warden", revealed: false });
  assert.equal(captured.token, TOKEN);
});
