import assert from "node:assert/strict";
import test from "node:test";
import { withMapSceneStore } from "../src/map-scene-store.js";
import { createAdvancedMapScene } from "../src/map-scenes.js";
import { MemoryCampaignStore } from "../src/store.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

function sourceMap() {
  return {
    title: "Ember Vault",
    mapType: "dungeon",
    seed: "store-seed",
    grid: { width: 24, height: 24, type: "square", scale: 5, units: "ft" },
    zones: [{ id: "vault", name: "Vault", x: 2, y: 2, width: 10, height: 10, revealed: true }],
    connections: [], pointsOfInterest: [], encounters: [], gmNotes: [],
  };
}

async function localStore() {
  const store = withMapSceneStore(new MemoryCampaignStore());
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
  return store;
}

test("local map scenes save, approve, filter players, and reset approval on revision", async () => {
  const store = await localStore();
  const source = sourceMap();
  const scene = createAdvancedMapScene(source);
  const saved = await store.saveMapScene(CAMPAIGN_ID, {
    name: "Ember Vault",
    gmScene: scene.gmScene,
    playerScene: scene.playerScene,
    expectedRevision: 0,
  }, source);
  assert.equal(saved.scene.revision, 1);
  assert.equal(saved.scene.approved, false);
  assert.equal(saved.scene.gmScene.projection, "gm");

  const playerBefore = await store.getMapScene(
    CAMPAIGN_ID,
    saved.scene.id,
    { localRole: "player" },
  );
  assert.equal(playerBefore, null);

  const approved = await store.approveMapScene(
    CAMPAIGN_ID,
    saved.scene.id,
    { expectedRevision: 1 },
  );
  assert.equal(approved.scene.approved, true);

  const playerAfter = await store.getMapScene(
    CAMPAIGN_ID,
    saved.scene.id,
    { localRole: "player" },
  );
  assert.equal(playerAfter.canManage, false);
  assert.equal(playerAfter.scene.gmScene, null);
  assert.equal(playerAfter.scene.sourceMap, null);
  assert.equal(playerAfter.scene.playerScene.projection, "player");

  const revised = structuredClone(scene);
  revised.gmScene.title = "Ember Vault Revised";
  revised.playerScene = (await import("../src/map-scenes.js")).createPlayerMapScene(revised.gmScene);
  const second = await store.saveMapScene(CAMPAIGN_ID, {
    sceneId: saved.scene.id,
    name: "Ember Vault Revised",
    gmScene: revised.gmScene,
    playerScene: revised.playerScene,
    expectedRevision: 1,
  }, source);
  assert.equal(second.scene.revision, 2);
  assert.equal(second.scene.approved, false);
  await assert.rejects(
    () => store.saveMapScene(CAMPAIGN_ID, {
      sceneId: saved.scene.id,
      name: "Stale",
      gmScene: revised.gmScene,
      playerScene: revised.playerScene,
      expectedRevision: 1,
    }, source),
    /reload before saving/i,
  );
});

test("map scene saves reject a mismatched source map hash", async () => {
  const store = await localStore();
  const source = sourceMap();
  const scene = createAdvancedMapScene(source);
  await assert.rejects(
    () => store.saveMapScene(CAMPAIGN_ID, {
      name: "Mismatch",
      gmScene: scene.gmScene,
      playerScene: scene.playerScene,
      expectedRevision: 0,
    }, { ...source, title: "Different" }),
    /does not match the scene sourceMapHash/i,
  );
});

test("Supabase map scene adapter forwards caller JWT and exact revisions", async () => {
  const calls = [];
  const store = withMapSceneStore({
    requiresAuth: true,
    client: {
      async rpc(name, args, token) {
        calls.push({ name, args, token });
        return { name, args };
      },
    },
  });
  const auth = { token: "caller-jwt", user: { id: USER_ID } };
  const source = sourceMap();
  const scene = createAdvancedMapScene(source);
  await store.listMapScenes(CAMPAIGN_ID, auth);
  await store.getMapScene(CAMPAIGN_ID, USER_ID, auth);
  await store.saveMapScene(CAMPAIGN_ID, {
    name: "Ember Vault",
    gmScene: scene.gmScene,
    playerScene: scene.playerScene,
    expectedRevision: 0,
  }, source, auth);
  await store.approveMapScene(CAMPAIGN_ID, USER_ID, { expectedRevision: 1 }, auth);

  assert.deepEqual(calls.map((call) => call.name), [
    "dnd_ai_map_scenes",
    "dnd_ai_map_scene",
    "dnd_ai_save_map_scene",
    "dnd_ai_approve_map_scene",
  ]);
  assert.ok(calls.every((call) => call.token === "caller-jwt"));
  assert.equal(calls[2].args.p_expected_revision, 0);
  assert.equal(calls[3].args.p_expected_revision, 1);
});
