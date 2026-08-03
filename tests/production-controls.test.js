import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { runWithProductionContext } from "../src/production-context.js";
import { withProductionControlStore } from "../src/production-control-store.js";
import { defaultGenerationPolicies, withProductionControls } from "../src/production-controls.js";

function fakeProvider() {
  let calls = 0;
  return {
    name: "mock",
    model: "deterministic-local",
    get calls() { return calls; },
    async generateTurn(campaign, request) {
      calls += 1;
      return {
        narration: `${request.actor} reaches the sealed gate. Choose how to proceed.`,
        spokenDialogue: [],
        suggestedChecks: [{ character: request.actor, ability: "Wisdom", skill: "Perception", dc: 12, reason: "Inspect the seal" }],
        choices: ["Inspect it", "Ask for help"],
        stateUpdates: { currentScene: campaign.currentScene, addWorldFacts: [], addOpenThreads: [], resolveOpenThreads: [], addNotes: [] },
        safety: { status: "ok", reason: "" },
      };
    },
  };
}

function store() {
  return withProductionControlStore({}, {
    defaultPolicies: defaultGenerationPolicies("mock", "deterministic-local"),
  });
}

const campaign = {
  id: "11111111-1111-4111-8111-111111111111",
  currentScene: "The sealed gate",
  notes: ["SECRET: The gate opens to dragonfire"],
};
const request = { actor: "Vorkesh", message: "I inspect the runes." };

test("provider boundary reserves, evaluates, finalizes, and records no raw prompt or output", async () => {
  const persistence = store();
  const provider = withProductionControls(fakeProvider(), persistence);
  const id = randomUUID();
  const result = await runWithProductionContext({ requestId: id, campaignId: campaign.id, userId: "local-user" },
    () => provider.generateTurn(campaign, request));
  assert.match(result.narration, /sealed gate/i);
  const usage = await persistence.listProductionUsage(campaign.id, 10);
  assert.equal(usage.events.length, 1);
  assert.equal(usage.events[0].status, "succeeded");
  assert.match(usage.events[0].inputHash, /^[a-f0-9]{64}$/);
  assert.match(usage.events[0].outputHash, /^[a-f0-9]{64}$/);
  assert.equal(usage.events[0].evaluationSummary.suiteVersion, "baseline-1");
  const serialized = JSON.stringify(usage.events[0]);
  assert.doesNotMatch(serialized, /inspect the runes|reaches the sealed gate|dragonfire/i);
  const evaluations = await persistence.listEvaluationRuns(campaign.id, 10);
  assert.equal(evaluations.evaluations.length, 1);
});

test("budget denial prevents the provider call", async () => {
  const persistence = store();
  await persistence.upsertProductionBudget({ campaignId: campaign.id, period: "daily", requestLimit: 0 });
  const raw = fakeProvider();
  const provider = withProductionControls(raw, persistence);
  await assert.rejects(
    runWithProductionContext({ requestId: randomUUID(), campaignId: campaign.id, userId: "local-user" },
      () => provider.generateTurn(campaign, request)),
    /blocked by production controls: request_limit/i,
  );
  assert.equal(raw.calls, 0);
});
