import assert from "node:assert/strict";
import test from "node:test";
import { MockAiProvider } from "../src/ai.js";
import {
  playerSafeSessionIntelligence,
  validateSessionIntelligenceRequest,
  validateSessionIntelligenceResult,
} from "../src/session-intelligence.js";
import { withSessionIntelligence } from "../src/session-intelligence-provider.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function context() {
  return {
    campaign: {
      id: CAMPAIGN_ID,
      name: "Emberforge Rising",
      system: "D&D 5e-compatible",
      tone: "Heroic fantasy",
      currentScene: "The lower forge",
      worldFacts: ["The lower forge belongs to Clan Emberforge."],
      openThreads: ["Find the missing smith."],
      notes: [],
      playerCharacters: [{ id: "pc-1", name: "Vorkesh", playerName: "Kirito", summary: "Dragonborn artificer" }],
    },
    workspace: {
      npcs: [{ id: "npc-1", name: "Ember Warden", revealed: true }],
      locations: [], factions: [], quests: [], loot: [], encounters: [], characters: [],
    },
    session: {
      id: SESSION_ID,
      title: "The Broken Crucible",
      status: "completed",
      agenda: "Investigate the forge",
      dm_notes: "The hidden saboteur escaped.",
    },
  };
}

function validResult() {
  return {
    version: 1,
    sessionTitle: "The Broken Crucible",
    gmRecap: "Private recap",
    playerRecap: "Public recap",
    canonFacts: [],
    contradictions: [],
    unresolvedThreads: [],
    entityChanges: [],
    nextSessionPrep: {
      openingScene: "",
      likelyNpcs: [],
      encounterIdeas: [],
      clues: [],
      risks: [],
      questions: [],
    },
  };
}

test("session intelligence request validation is strict", () => {
  const request = validateSessionIntelligenceRequest({
    sourceNotes: "FACT: The crucible is damaged.",
    transcript: [{ speaker: "Vorkesh", text: "I inspect the runes.", public: true }],
    focus: ["continuity"],
  });
  assert.equal(request.includePrep, true);
  assert.equal(request.transcript.length, 1);
  assert.throws(
    () => validateSessionIntelligenceRequest({ sourceNotes: "notes", unexpected: true }),
    /unexpected is not allowed/,
  );
});

test("mock session intelligence separates GM and player material", async () => {
  const provider = withSessionIntelligence(new MockAiProvider());
  const result = await provider.generateSessionIntelligence(context(), {
    sourceNotes: [
      "PUBLIC FACT: The crucible was damaged during the fight.",
      "SECRET FACT: The Ember Warden caused the failure.",
      "CONTRADICTION: The missing smith fled || Earlier notes say the smith was captured",
      "PUBLIC THREAD: Repair the crucible before the next moon.",
      "NPC: The Ember Warden is now suspicious of the party.",
    ].join("\n"),
    transcript: [
      { speaker: "Vorkesh", text: "I promise to repair it.", public: true },
      { speaker: "GM", text: "The hidden tunnel leads to the saboteur.", public: false },
    ],
    focus: [],
    includePrep: true,
  });

  assert.match(result.gmRecap, /Ember Warden caused the failure/);
  assert.match(result.gmRecap, /hidden tunnel leads to the saboteur/);
  assert.doesNotMatch(result.playerRecap, /Ember Warden caused the failure/);
  assert.doesNotMatch(result.playerRecap, /hidden tunnel leads to the saboteur/);
  assert.equal(result.canonFacts[0].public, true);
  assert.equal(result.canonFacts[1].public, false);
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.unresolvedThreads[0].public, true);
  assert.equal(result.entityChanges[0].proposedTool, "upsert_npc");
  assert.match(result.nextSessionPrep.openingScene, /Repair the crucible/);
});

test("OpenAI session intelligence uses a strict empty-object tool argument schema", async () => {
  let request;
  const provider = withSessionIntelligence({
    name: "openai",
    model: "test-model",
    async requestStructured(value) {
      request = value;
      return validResult();
    },
  });
  const result = await provider.generateSessionIntelligence(context(), {
    sourceNotes: "PUBLIC FACT: The crucible is damaged.",
    transcript: [],
    focus: [],
    includePrep: true,
  });
  assert.equal(result.playerRecap, "Public recap");
  assert.equal(request.name, "dnd_session_intelligence");
  assert.equal(
    request.schema.properties.entityChanges.items.properties.arguments.additionalProperties,
    false,
  );
  assert.deepEqual(
    request.schema.properties.entityChanges.items.properties.arguments.properties,
    {},
  );
});

test("player-safe projection removes GM recap, contradictions, prep, and private facts", () => {
  const full = validateSessionIntelligenceResult({
    version: 1,
    sessionTitle: "Test Session",
    gmRecap: "Private recap",
    playerRecap: "Public recap",
    canonFacts: [
      { statement: "Public fact", confidence: "high", evidence: "Observed", public: true },
      { statement: "Secret fact", confidence: "medium", evidence: "GM note", public: false },
    ],
    contradictions: [{
      claim: "A", conflictsWith: "B", severity: "warning", recommendation: "Review",
    }],
    unresolvedThreads: [
      { thread: "Public thread", status: "open", public: true, notes: "" },
      { thread: "Secret thread", status: "open", public: false, notes: "" },
    ],
    entityChanges: [],
    nextSessionPrep: {
      openingScene: "Secret prep", likelyNpcs: [], encounterIdeas: [], clues: [], risks: [], questions: [],
    },
  });
  const player = playerSafeSessionIntelligence(full);
  assert.deepEqual(Object.keys(player).sort(), ["canonFacts", "playerRecap", "sessionTitle", "unresolvedThreads", "version"]);
  assert.equal(player.canonFacts.length, 1);
  assert.equal(player.unresolvedThreads.length, 1);
  assert.equal("gmRecap" in player, false);
});
