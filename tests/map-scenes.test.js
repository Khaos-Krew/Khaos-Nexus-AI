import assert from "node:assert/strict";
import test from "node:test";
import {
  createAdvancedMapScene,
  createMapSceneExport,
  createPlayerMapScene,
  renderMapSceneSvg,
  sceneHash,
  validateMapScene,
  validateMapSceneSaveRequest,
} from "../src/map-scenes.js";

function sourceMap() {
  return {
    title: "The Ember Vault",
    mapType: "dungeon",
    seed: "ember-seed",
    grid: { width: 32, height: 24, type: "square", scale: 5, units: "ft" },
    zones: [
      { id: "forge", name: "Lower Forge", x: 2, y: 2, width: 10, height: 8, revealed: true },
      { id: "vault", name: "Hidden Vault", x: 16, y: 4, width: 10, height: 10, secret: true },
      { id: "upper", name: "Upper Gantry", x: 5, y: 15, width: 12, height: 6 },
    ],
    connections: [
      { from: "forge", to: "vault", secret: true, locked: true, label: "Runed Door" },
      { from: "forge", to: "upper", label: "Stairs" },
    ],
    pointsOfInterest: [
      { name: "Damaged Crucible", zoneId: "forge", description: "A cracked ancestral crucible." },
      { name: "Saboteur Cache", zoneId: "vault", description: "Hidden tools.", secret: true },
    ],
    encounters: [
      { name: "Forge Guardian", zoneId: "vault", description: "A dormant construct.", hidden: true },
    ],
    gmNotes: ["The vault door responds to draconic runes."],
  };
}

test("advanced scenes are deterministic and distribute zones across levels", () => {
  const first = createAdvancedMapScene(sourceMap(), { levelCount: 2, levelHeight: 15 });
  const second = createAdvancedMapScene(sourceMap(), { levelCount: 2, levelHeight: 15 });
  assert.deepEqual(first, second);
  assert.equal(first.gmScene.levels.length, 2);
  assert.equal(first.gmScene.levels[1].elevation, 15);
  assert.equal(first.gmScene.sourceMapHash, sceneHash(sourceMap()));
  assert.equal(first.gmScene.projection, "gm");
  assert.equal(first.playerScene.projection, "player");
});

test("player scene removes secret, hidden, private, and unrevealed geometry", () => {
  const { gmScene, playerScene } = createAdvancedMapScene(sourceMap(), { levelCount: 2 });
  assert.match(gmScene.gmNotes, /draconic runes/);
  assert.equal(playerScene.gmNotes, "");
  assert.ok(gmScene.levels.some((level) => level.doors.some((door) => door.secret)));
  assert.ok(playerScene.levels.every((level) => level.doors.every((door) => !door.secret)));
  assert.ok(gmScene.levels.some((level) => level.tokens.some((token) => token.hidden)));
  assert.ok(playerScene.levels.every((level) => level.tokens.every((token) => !token.hidden)));
  assert.ok(playerScene.levels.every((level) => level.pointsOfInterest.every((poi) => !poi.secret && poi.revealed)));
  assert.ok(playerScene.levels.every((level) => level.fogRegions.every((fog) => fog.revealed)));
  assert.doesNotThrow(() => validateMapScene(playerScene));

  const unsafe = structuredClone(playerScene);
  unsafe.levels[0].doors.push({
    id: "11111111-1111-4111-8111-111111111111",
    a: { x: 1, y: 1 },
    b: { x: 1, y: 2 },
    state: "closed",
    secret: true,
    locked: false,
    label: "Secret",
  });
  assert.throws(() => validateMapScene(unsafe), /cannot contain secret/i);
});

test("save validation requires the exact canonical player projection", () => {
  const generated = createAdvancedMapScene(sourceMap());
  assert.doesNotThrow(() => validateMapSceneSaveRequest({
    name: "The Ember Vault",
    gmScene: generated.gmScene,
    playerScene: generated.playerScene,
    expectedRevision: 0,
  }));

  const manipulated = structuredClone(generated.playerScene);
  manipulated.title = "Manipulated";
  assert.throws(() => validateMapSceneSaveRequest({
    name: "The Ember Vault",
    gmScene: generated.gmScene,
    playerScene: manipulated,
    expectedRevision: 0,
  }), /canonical filtered projection/i);

  const rebuilt = createPlayerMapScene(generated.gmScene);
  assert.equal(sceneHash(rebuilt), sceneHash(generated.playerScene));
});

test("portable exports are deterministic, hashed, and projection-aware", () => {
  const { gmScene, playerScene } = createAdvancedMapScene(sourceMap(), { levelCount: 2 });
  for (const target of ["khaos_scene", "universal_vtt_style", "foundry_scene_data"]) {
    const first = createMapSceneExport(playerScene, target, 3);
    const second = createMapSceneExport(playerScene, target, 3);
    assert.deepEqual(first, second);
    assert.equal(first.hash.length, 64);
    assert.match(first.filename, /-r3-player-/);
    assert.equal(first.payload.format, target);
  }
  const gmExport = createMapSceneExport(gmScene, "khaos_scene", 1);
  assert.equal(gmExport.projection, "gm");
  assert.match(gmExport.filename, /-gm-/);
});

test("scene SVG renders deterministic levels and escapes labels", () => {
  const map = sourceMap();
  map.title = "Ember <Vault>";
  const { playerScene } = createAdvancedMapScene(map, { levelCount: 2 });
  const svg = renderMapSceneSvg(playerScene, 0);
  assert.match(svg, /^<svg/);
  assert.match(svg, /Ember &lt;Vault&gt;/);
  assert.doesNotMatch(svg, /Saboteur Cache/);
  assert.equal(svg, renderMapSceneSvg(playerScene, 0));
});
