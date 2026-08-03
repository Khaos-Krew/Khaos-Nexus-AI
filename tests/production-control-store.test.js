import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { withProductionControlStore } from "../src/production-control-store.js";
import { defaultGenerationPolicies, generationPromptRegistry } from "../src/production-controls.js";

function reservation(overrides = {}) {
  const prompt = generationPromptRegistry.generateTurn;
  return {
    requestId: randomUUID(),
    campaignId: "11111111-1111-4111-8111-111111111111",
    feature: prompt.feature,
    provider: "mock",
    model: "deterministic-local",
    promptId: prompt.promptId,
    promptVersion: prompt.promptVersion,
    promptHash: prompt.promptHash,
    estimatedInputTokens: 100,
    reservedOutputTokens: 200,
    inputHash: "a".repeat(64),
    ...overrides,
  };
}

function localStore() {
  return withProductionControlStore({}, {
    defaultPolicies: defaultGenerationPolicies("mock", "deterministic-local"),
  });
}

test("local reservations and finalization are idempotent and hash-only", async () => {
  const store = localStore();
  const input = reservation();
  const first = await store.reserveGeneration(input, { userId: "local-user" });
  const duplicate = await store.reserveGeneration(input, { userId: "local-user" });
  assert.equal(first.allowed, true);
  assert.equal(duplicate.event.id, first.event.id);

  const finalized = await store.finalizeGeneration({
    requestId: input.requestId,
    status: "succeeded",
    inputTokens: 90,
    outputTokens: 120,
    cachedInputTokens: 5,
    reasoningTokens: 10,
    latencyMs: 250,
    outputHash: "b".repeat(64),
    providerRequestId: "response_123",
    errorCode: null,
    evaluationSummary: { outcome: "pass" },
  });
  const secondFinalization = await store.finalizeGeneration({ ...finalized, requestId: input.requestId });
  assert.equal(secondFinalization.id, finalized.id);
  assert.equal(finalized.status, "succeeded");
  assert.equal(finalized.inputHash, "a".repeat(64));
  assert.equal(finalized.outputHash, "b".repeat(64));
  assert.doesNotMatch(JSON.stringify(finalized), /raw prompt|raw output/i);
});

test("request, token, and cost budgets block before provider execution", async () => {
  const store = localStore();
  const manager = { localRole: "dm", userId: "local-user" };
  await store.upsertProductionBudget({ period: "daily", requestLimit: 1 }, manager);
  const firstInput = reservation();
  assert.equal((await store.reserveGeneration(firstInput, manager)).allowed, true);
  await store.finalizeGeneration({
    requestId: firstInput.requestId, status: "succeeded", inputTokens: 100, outputTokens: 100,
    cachedInputTokens: 0, reasoningTokens: 0, latencyMs: 1, outputHash: "b".repeat(64),
    providerRequestId: "", errorCode: null, evaluationSummary: {},
  }, manager);
  const second = await store.reserveGeneration(reservation(), manager);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "request_limit");
});

test("policy mismatches fail closed", async () => {
  const store = localStore();
  const denied = await store.reserveGeneration(reservation({ model: "unapproved-model" }));
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "model_policy_not_found");
});

test("Supabase adapter forwards caller JWT and tenant-scoped budget fields", async () => {
  const calls = [];
  const store = withProductionControlStore({
    requiresAuth: true,
    client: { async rpc(name, args, token) { calls.push({ name, args, token }); return { name, args }; } },
  });
  const auth = { token: "caller-jwt", user: { id: randomUUID() } };
  await store.upsertProductionBudget({
    tenantId: "11111111-1111-4111-8111-111111111111",
    campaignId: "22222222-2222-4222-8222-222222222222",
    period: "monthly",
    requestLimit: 100,
  }, auth);
  await store.reserveGeneration(reservation(), auth);
  await store.finalizeGeneration({
    requestId: reservation().requestId, status: "failed", inputTokens: 0, outputTokens: 0,
    cachedInputTokens: 0, reasoningTokens: 0, latencyMs: 10, outputHash: null,
    providerRequestId: "", errorCode: "TEST", evaluationSummary: {},
  }, auth);
  assert.deepEqual(calls.map((entry) => entry.name), [
    "dnd_ai_upsert_budget", "dnd_ai_reserve_generation", "dnd_ai_finalize_generation",
  ]);
  assert.equal(calls[0].args.p_tenant_id, "11111111-1111-4111-8111-111111111111");
  assert.ok(calls.every((entry) => entry.token === "caller-jwt"));
});
