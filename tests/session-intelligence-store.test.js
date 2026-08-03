import assert from "node:assert/strict";
import test from "node:test";
import { withSessionIntelligenceStore } from "../src/session-intelligence-store.js";
import { MemoryCampaignStore } from "../src/store.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

const intelligence = {
  version: 1,
  sessionTitle: "The Broken Crucible",
  gmRecap: "The hidden saboteur escaped.",
  playerRecap: "The party protected the damaged crucible.",
  canonFacts: [
    { statement: "The crucible is damaged.", confidence: "high", evidence: "Observed", public: true },
    { statement: "The warden is the saboteur.", confidence: "medium", evidence: "GM note", public: false },
  ],
  contradictions: [],
  unresolvedThreads: [
    { thread: "Repair the crucible.", status: "open", public: true, notes: "Public objective with private source notes." },
    { thread: "Find the saboteur.", status: "open", public: false, notes: "" },
  ],
  entityChanges: [],
  nextSessionPrep: {
    openingScene: "The forge alarms ring.", likelyNpcs: [], encounterIdeas: [], clues: [], risks: [], questions: [],
  },
};

async function localStore() {
  const store = withSessionIntelligenceStore(new MemoryCampaignStore());
  await store.create({
    id: CAMPAIGN_ID,
    name: "Emberforge Rising",
    system: "D&D 5e-compatible",
    mode: "co-dm",
    tone: "Heroic fantasy",
    contentRating: "teen",
    lore: [], rulesNotes: [], playerCharacters: [],
    safety: { lines: [], veils: [], pauseWords: ["pause"] },
    currentScene: "The forge", worldFacts: [], openThreads: [], notes: [], transcript: [],
    status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  await store.executeWorkspaceTool(CAMPAIGN_ID, "upsert_session", {
    id: SESSION_ID,
    title: "The Broken Crucible",
    status: "completed",
    startsAt: null,
    endsAt: null,
    timezone: "UTC",
    agenda: "",
    dmNotes: "",
    recapDraft: "",
    metadata: {},
  });
  return store;
}

test("local session intelligence saves, resets approval, and filters players", async () => {
  const store = await localStore();
  const saved = await store.saveSessionIntelligence(CAMPAIGN_ID, SESSION_ID, intelligence, 0);
  assert.equal(saved.revision, 1);
  assert.equal(saved.approved, false);
  assert.equal(saved.intelligence.gmRecap, intelligence.gmRecap);

  const approved = await store.approveSessionIntelligence(CAMPAIGN_ID, SESSION_ID, 1);
  assert.equal(approved.approved, true);

  const player = await store.getSessionIntelligence(
    CAMPAIGN_ID,
    SESSION_ID,
    { localRole: "player" },
  );
  assert.equal(player.intelligence.playerRecap, intelligence.playerRecap);
  assert.equal(player.intelligence.canonFacts.length, 1);
  assert.deepEqual(Object.keys(player.intelligence.canonFacts[0]).sort(), ["confidence", "statement"]);
  assert.deepEqual(Object.keys(player.intelligence.unresolvedThreads[0]).sort(), ["status", "thread"]);
  assert.equal("gmRecap" in player.intelligence, false);

  const changed = { ...intelligence, playerRecap: "Updated public recap." };
  const second = await store.saveSessionIntelligence(CAMPAIGN_ID, SESSION_ID, changed, 1);
  assert.equal(second.revision, 2);
  assert.equal(second.approved, false);
  await assert.rejects(
    () => store.saveSessionIntelligence(CAMPAIGN_ID, SESSION_ID, changed, 1),
    /reload before saving/,
  );
});

test("Supabase session adapter forwards caller JWT and exact revisions", async () => {
  const calls = [];
  const store = withSessionIntelligenceStore({
    requiresAuth: true,
    client: {
      async rpc(name, args, token) {
        calls.push({ name, args, token });
        return { name, args };
      },
    },
  });
  const auth = { token: "user-access-token", user: { id: CAMPAIGN_ID } };
  await store.getSessionIntelligence(CAMPAIGN_ID, SESSION_ID, auth);
  await store.saveSessionIntelligence(CAMPAIGN_ID, SESSION_ID, intelligence, 3, auth);
  await store.approveSessionIntelligence(CAMPAIGN_ID, SESSION_ID, 4, auth);

  assert.deepEqual(calls.map((call) => call.name), [
    "dnd_ai_session_intelligence",
    "dnd_ai_save_session_intelligence",
    "dnd_ai_approve_session_intelligence",
  ]);
  assert.equal(calls[1].args.p_expected_revision, 3);
  assert.equal(calls[2].args.p_expected_revision, 4);
  assert.ok(calls.every((call) => call.token === "user-access-token"));
});
