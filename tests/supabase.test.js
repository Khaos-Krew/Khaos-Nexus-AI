import assert from "node:assert/strict";
import test from "node:test";
import {
  SupabaseAuthVerifier,
  SupabaseCampaignStore,
  SupabaseRestClient,
} from "../src/supabase.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_ID = "22222222-2222-4222-8222-222222222222";
const TENANT_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "header.payload.signature-value-long-enough";

test("SupabaseAuthVerifier validates tokens with the Auth server", async () => {
  let captured;
  const verifier = new SupabaseAuthVerifier({
    url: "https://example.supabase.co",
    publishableKey: "sb_publishable_test",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({ id: USER_ID, email: "dm@example.com", app_metadata: { plan: "pro" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const user = await verifier.verify(TOKEN);
  assert.equal(user.id, USER_ID);
  assert.equal(user.email, "dm@example.com");
  assert.equal(captured.url, "https://example.supabase.co/auth/v1/user");
  assert.equal(captured.init.headers.apikey, "sb_publishable_test");
  assert.equal(captured.init.headers.Authorization, `Bearer ${TOKEN}`);
});

test("SupabaseAuthVerifier rejects invalid tokens", async () => {
  const verifier = new SupabaseAuthVerifier({
    url: "https://example.supabase.co",
    publishableKey: "sb_publishable_test",
    fetchImpl: async () => new Response(JSON.stringify({ message: "invalid JWT" }), { status: 401 }),
  });
  await assert.rejects(() => verifier.verify(TOKEN), (error) => {
    assert.equal(error.status, 401);
    assert.match(error.message, /invalid JWT/i);
    return true;
  });
});

test("Supabase clients reject service-role and secret keys", () => {
  assert.throws(
    () => new SupabaseRestClient({ url: "https://example.supabase.co", publishableKey: "sb_secret_bad" }),
    /publishable key/i,
  );
  assert.throws(
    () => new SupabaseAuthVerifier({ url: "https://example.supabase.co", publishableKey: "service_role" }),
    /publishable key/i,
  );
});

test("SupabaseRestClient sends caller JWTs to RPC endpoints", async () => {
  let captured;
  const client = new SupabaseRestClient({
    url: "https://example.supabase.co",
    publishableKey: "sb_publishable_test",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ campaigns: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const result = await client.rpc("dnd_campaign_list", {}, TOKEN);
  assert.deepEqual(result, { campaigns: [] });
  assert.equal(captured.url, "https://example.supabase.co/rest/v1/rpc/dnd_campaign_list");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers.apikey, "sb_publishable_test");
  assert.equal(captured.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(captured.init.body, "{}");
});

test("SupabaseCampaignStore maps filtered workspace data into AI campaign state", async () => {
  const calls = [];
  const workspace = {
    role: "dm",
    campaign: {
      id: CAMPAIGN_ID,
      tenant_id: TENANT_ID,
      name: "Emberforge Rising",
      description: "Dark heroic fantasy",
      status: "active",
      ruleset: "5e_2024",
      current_location: "Ashen Crucible",
      ai_state: {
        mode: "co-dm",
        contentRating: "teen",
        lore: ["The forge was sealed."],
        rulesNotes: ["Milestone advancement"],
        safety: { lines: [], veils: [], pauseWords: ["pause"] },
        worldFacts: [],
        openThreads: [],
        notes: [],
        transcript: [],
      },
      created_at: "2026-08-03T00:00:00.000Z",
      updated_at: "2026-08-03T00:01:00.000Z",
    },
    characters: [
      { id: USER_ID, name: "Vorkesh", player_name: "Kirito", summary: "Dragonborn artificer" },
    ],
  };
  const client = {
    async rpc(name, args, token) {
      calls.push({ name, args, token });
      return workspace;
    },
  };
  const store = new SupabaseCampaignStore(client);
  const context = { token: TOKEN, user: { id: USER_ID } };
  const campaign = await store.get(CAMPAIGN_ID, context);

  assert.equal(campaign.id, CAMPAIGN_ID);
  assert.equal(campaign.tenantId, TENANT_ID);
  assert.equal(campaign.name, "Emberforge Rising");
  assert.equal(campaign.playerCharacters[0].name, "Vorkesh");
  assert.equal(campaign.currentScene, "Ashen Crucible");
  assert.equal(calls[0].name, "dnd_campaign_workspace");
  assert.equal(calls[0].token, TOKEN);
});

test("SupabaseCampaignStore creates campaigns through the transactional RPC", async () => {
  let captured;
  const client = {
    async rpc(name, args, token) {
      captured = { name, args, token };
      return {
        role: "dm",
        campaign: {
          id: CAMPAIGN_ID,
          tenant_id: TENANT_ID,
          name: args.p_name,
          description: args.p_description,
          status: "planning",
          ruleset: args.p_ruleset,
          current_location: args.p_current_location,
          ai_state: args.p_ai_state,
          created_at: "2026-08-03T00:00:00.000Z",
          updated_at: "2026-08-03T00:00:00.000Z",
        },
        characters: [],
      };
    },
  };
  const store = new SupabaseCampaignStore(client);
  const context = { token: TOKEN, user: { id: USER_ID } };
  const created = await store.create(
    {
      tenantId: TENANT_ID,
      name: "Emberforge Rising",
      tone: "Dark heroic fantasy",
      system: "5e_2024",
      mode: "co-dm",
      contentRating: "teen",
      lore: [],
      rulesNotes: [],
      safety: { lines: [], veils: [], pauseWords: ["pause"] },
      worldFacts: [],
      openThreads: [],
      notes: [],
      transcript: [],
      currentScene: "",
      playerCharacters: [],
    },
    context,
  );

  assert.equal(created.id, CAMPAIGN_ID);
  assert.equal(captured.name, "dnd_ai_create_campaign");
  assert.equal(captured.args.p_tenant_id, TENANT_ID);
  assert.equal(captured.token, TOKEN);
});
