import assert from "node:assert/strict";
import test from "node:test";
import { withLaunchControlStore } from "../src/launch-control-store.js";
import { runWithProductionContext } from "../src/production-context.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

test("authenticated reservations call the v2 RPC with explicit tenant scope", async () => {
  const calls = [];
  const store = withLaunchControlStore({
    requiresAuth: true,
    client: {
      async rpc(name, args, token) {
        calls.push({ name, args, token });
        return { allowed: false, reason: "budget_required" };
      },
    },
  });
  const result = await runWithProductionContext({ tenantId }, () => store.reserveGeneration({
    requestId: "33333333-3333-4333-8333-333333333333",
    campaignId: null,
    feature: "co_dm.draft",
    provider: "openai",
    model: "gpt-5-mini",
    promptId: "dnd-co-dm-draft",
    promptVersion: "1",
    promptHash: "a".repeat(64),
    estimatedInputTokens: 100,
    reservedOutputTokens: 200,
    inputHash: "b".repeat(64),
  }, { token: "access-token", user: { id: userId } }));

  assert.equal(result.reason, "budget_required");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "dnd_ai_reserve_generation_v2");
  assert.equal(calls[0].args.p_tenant_id, tenantId);
  assert.equal(calls[0].token, "access-token");
});

test("campaign reservations may omit the tenant header and let PostgreSQL derive it", async () => {
  const calls = [];
  const store = withLaunchControlStore({
    requiresAuth: true,
    client: { async rpc(name, args) { calls.push({ name, args }); return { allowed: true }; } },
  });
  await store.reserveGeneration({
    requestId: "44444444-4444-4444-8444-444444444444",
    campaignId: "55555555-5555-4555-8555-555555555555",
    feature: "campaign.turn",
    provider: "openai",
    model: "gpt-5-mini",
    promptId: "dnd-turn",
    promptVersion: "1",
    promptHash: "c".repeat(64),
    estimatedInputTokens: 100,
    reservedOutputTokens: 200,
    inputHash: "d".repeat(64),
  }, { token: "access-token", user: { id: userId } });
  assert.equal(calls[0].args.p_tenant_id, null);
});
