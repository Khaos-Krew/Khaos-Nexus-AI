import assert from "node:assert/strict";
import test from "node:test";
import { withRetrievalStore } from "../src/retrieval-store.js";
import { withSessionIntelligenceStore } from "../src/session-intelligence-store.js";
import { MemoryCampaignStore } from "../src/store.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

async function localStore() {
  const store = withRetrievalStore(withSessionIntelligenceStore(new MemoryCampaignStore()));
  await store.create({
    id: CAMPAIGN_ID,
    name: "Emberforge Rising",
    system: "D&D 5e-compatible",
    mode: "co-dm",
    tone: "Heroic fantasy",
    contentRating: "teen",
    lore: [], rulesNotes: [], playerCharacters: [],
    safety: { lines: [], veils: [], pauseWords: ["pause"] },
    currentScene: "The lower forge", worldFacts: [], openThreads: [], notes: [], transcript: [],
    status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return store;
}

test("local retrieval deduplicates entries and filters manager-only sources", async () => {
  const store = await localStore();
  const publicSource = await store.upsertRetrievalSource(CAMPAIGN_ID, {
    name: "Public Campaign Notes",
    licenseType: "user_authored",
    fullTextAllowed: true,
    confirmedRightToUse: true,
    visibility: "campaign_members",
  });
  const entryInput = {
    contentType: "location",
    name: "The Ember Vault",
    summary: "A hidden vault beneath the lower forge.",
    fullText: "The Ember Vault contains the damaged crucible and ancestral runes.",
    contentOrigin: "user_authored",
    visibility: "inherit",
    confirmedRightToUse: true,
  };
  const first = await store.upsertRetrievalEntry(CAMPAIGN_ID, publicSource.id, entryInput);
  const duplicate = await store.upsertRetrievalEntry(CAMPAIGN_ID, publicSource.id, entryInput);
  assert.equal(duplicate.id, first.id);

  const secretSource = await store.upsertRetrievalSource(CAMPAIGN_ID, {
    name: "GM Secrets",
    licenseType: "user_authored",
    fullTextAllowed: true,
    confirmedRightToUse: true,
    visibility: "manager_only",
  });
  await store.upsertRetrievalEntry(CAMPAIGN_ID, secretSource.id, {
    contentType: "secret",
    name: "Saboteur Identity",
    summary: "The Ember Warden damaged the crucible.",
    contentOrigin: "user_authored",
  });

  const manager = await store.searchRetrieval(CAMPAIGN_ID, { query: "Ember crucible", limit: 10 });
  assert.equal(manager.results.length, 2);
  assert.ok(manager.results.every((result) => result.excerpt.length <= 700));
  assert.match(manager.results[0].citationId, /^(source:).+:entry:/);

  const player = await store.searchRetrieval(
    CAMPAIGN_ID,
    { query: "Ember crucible", limit: 10 },
    { localRole: "player" },
  );
  assert.equal(player.results.length, 1);
  assert.equal(player.results[0].sourceName, "Public Campaign Notes");

  const playerSources = await store.getRetrievalSources(CAMPAIGN_ID, { localRole: "player" });
  assert.equal(playerSources.sources.length, 1);
  assert.equal(playerSources.sources[0].entryCount, 1);
});

test("local retrieval enforces source license restrictions", async () => {
  const store = await localStore();
  const source = await store.upsertRetrievalSource(CAMPAIGN_ID, {
    name: "Restricted Reference",
    licenseType: "metadata_only",
    visibility: "manager_only",
  });
  await assert.rejects(
    () => store.upsertRetrievalEntry(CAMPAIGN_ID, source.id, {
      contentType: "reference",
      name: "Restricted Text",
      summary: "Metadata summary",
      fullText: "Full source text",
      contentOrigin: "licensed_full_text",
      confirmedRightToUse: true,
    }),
    /Full text is not allowed|Restricted sources/i,
  );
});

test("Supabase retrieval adapter forwards the linked caller JWT", async () => {
  const calls = [];
  const store = withRetrievalStore({
    requiresAuth: true,
    client: {
      async rpc(name, args, token) {
        calls.push({ name, args, token });
        return name === "dnd_ai_search_retrieval"
          ? { role: "dm", canManage: true, query: args.p_query, results: [], excerptLimit: 700, resultLimit: args.p_limit }
          : { ok: true };
      },
    },
  });
  const auth = { token: "caller-jwt", user: { id: USER_ID } };
  await store.getRetrievalSources(CAMPAIGN_ID, auth);
  await store.upsertRetrievalSource(CAMPAIGN_ID, {
    name: "Notes",
    licenseType: "user_authored",
    visibility: "manager_only",
  }, auth);
  await store.upsertRetrievalEntry(CAMPAIGN_ID, CAMPAIGN_ID, {
    contentType: "note",
    name: "Forge",
    summary: "Forge notes",
    contentOrigin: "user_authored",
  }, auth);
  await store.searchRetrieval(CAMPAIGN_ID, { query: "forge", limit: 4 }, auth);

  assert.deepEqual(calls.map((call) => call.name), [
    "dnd_ai_retrieval_sources",
    "dnd_ai_upsert_retrieval_source",
    "dnd_ai_upsert_retrieval_entry",
    "dnd_ai_search_retrieval",
  ]);
  assert.ok(calls.every((call) => call.token === "caller-jwt"));
  assert.equal(calls[3].args.p_limit, 4);
});
