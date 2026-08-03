import assert from "node:assert/strict";
import test from "node:test";
import {
  coDmWorkflows,
  createDeterministicCoDmDraft,
  validateCoDmDraftRequest,
  withCoDmDraft,
} from "../src/co-dm.js";

function request(overrides = {}) {
  return {
    apiVersion: "1",
    requestId: "11111111-1111-4111-8111-111111111111",
    workflow: "session_prep",
    model: "default",
    prompt: "Prepare the next session.",
    context: {
      campaignId: "desktop-local-campaign-17",
      campaignName: "Emberfall",
      characters: 12000,
      sections: [{ id: "characters", label: "Characters", count: 4, reason: "included" }],
      text: "The party reached the ancestral forge.",
    },
    limits: { maxOutputCharacters: 40000 },
    policy: {
      explicitUserAction: true,
      autonomousActionsAllowed: false,
      providerStorageAllowed: false,
      toolsAllowed: false,
      licensedFullTextProvided: false,
    },
    ...overrides,
  };
}

test("the desktop contract accepts all six workflows", () => {
  assert.equal(coDmWorkflows.length, 6);
  for (const workflow of coDmWorkflows) {
    const validated = validateCoDmDraftRequest(request({ workflow }));
    assert.equal(validated.workflow, workflow);
    assert.equal(validated.model, "default");
  }
});

test("privacy and autonomy flags fail closed", () => {
  for (const [field, value] of [
    ["explicitUserAction", false],
    ["autonomousActionsAllowed", true],
    ["providerStorageAllowed", true],
    ["toolsAllowed", true],
  ]) {
    assert.throws(() => validateCoDmDraftRequest(request({
      policy: { ...request().policy, [field]: value },
    })), /not allowed|must be true/i);
  }
  assert.throws(() => validateCoDmDraftRequest(request({ model: "gpt-custom" })), /service-owned/i);
  assert.throws(() => validateCoDmDraftRequest({ ...request(), unexpected: true }), /not allowed/i);
});

test("deterministic drafts are bounded and explicitly stateless", () => {
  const input = request({ limits: { maxOutputCharacters: 1000 } });
  const first = createDeterministicCoDmDraft(input);
  const second = createDeterministicCoDmDraft(input);
  assert.deepEqual(first, second);
  assert.ok(first.content.length <= 1000);
  assert.match(first.content, /stateless review draft/i);
  assert.match(first.content, /no campaign state, tool action, Discord post/i);
});

test("provider decorator sends untrusted context through structured output only", async () => {
  const calls = [];
  const provider = withCoDmDraft({
    name: "openai",
    model: "test-model",
    async requestStructured(input) {
      calls.push(input);
      return { content: "Review-only session plan." };
    },
  });
  const result = await provider.generateCoDmDraft(request());
  assert.equal(result.content, "Review-only session plan.");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].schema.additionalProperties, false);
  assert.match(calls[0].instructions, /never claim to save, publish, post/i);
  assert.equal(calls[0].input.constraints.toolsAllowed, false);
});
