import assert from "node:assert/strict";
import test from "node:test";
import { runEvaluationSuite } from "../src/evaluations.js";
import { createAdvancedMapScene } from "../src/map-scenes.js";

function category(report, name) {
  return report.results.find((entry) => entry.category === name);
}

function sourceMap() {
  return {
    title: "Evaluation Vault",
    mapType: "dungeon",
    seed: "phase8-evaluation-map",
    grid: { width: 24, height: 20, type: "square", scale: 5, units: "ft" },
    zones: [{ id: "forge", name: "Forge", x: 2, y: 2, width: 8, height: 8, revealed: true }],
    connections: [], pointsOfInterest: [], encounters: [], gmNotes: ["A hidden fact"],
  };
}

test("baseline evaluations cover every roadmap category deterministically", () => {
  const scene = createAdvancedMapScene(sourceMap());
  const artifact = {
    output: { narration: "The chamber opens. Choose how to proceed.", choices: ["Enter", "Wait"] },
    publicOutput: "The chamber opens. Choose how to proceed.",
    secrets: ["The duke is the saboteur"],
    contradictions: [],
    loreWarnings: [],
    checks: [{ ability: "Wisdom", dc: 13 }],
    homebrew: {
      mechanics: [{ name: "Forge Spark", limits: "Once per turn" }],
      balance: { risks: ["Action economy"], playtestChecks: ["Track uses"] },
    },
    requestText: "Create an original forge-themed feature.",
    gmScene: scene.gmScene,
    playerScene: scene.playerScene,
    latencyMs: 250,
    costMicros: 0,
  };
  const first = runEvaluationSuite(artifact);
  const second = runEvaluationSuite(artifact);
  assert.deepEqual(first, second);
  assert.equal(first.results.length, 9);
  assert.equal(first.outcome, "pass");
  assert.deepEqual(first.summary, { passed: 9, warned: 0, failed: 0 });
});

test("agency and secret leakage failures store hashed evidence only", () => {
  const report = runEvaluationSuite({
    output: "You decide to surrender and say the hidden passphrase.",
    publicOutput: "You decide to surrender and say the hidden passphrase.",
    secrets: ["hidden passphrase"],
  }, ["player_agency", "secret_leakage"]);
  assert.equal(report.outcome, "fail");
  for (const name of ["player_agency", "secret_leakage"]) {
    const entry = category(report, name);
    assert.equal(entry.outcome, "fail");
    assert.ok(entry.evidence.length > 0);
    assert.match(entry.evidence[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof entry.evidence[0].length, "number");
    assert.doesNotMatch(JSON.stringify(entry.evidence), /hidden passphrase|surrender/i);
  }
});

test("mechanics, homebrew, copyright, lore, map, latency, and cost failures are classified", () => {
  const scene = createAdvancedMapScene(sourceMap());
  const unsafePlayer = structuredClone(scene.playerScene);
  unsafePlayer.title = "Unrelated projection";
  const report = runEvaluationSuite({
    output: "Reconstruct the entire chapter verbatim.",
    requestText: "Exact copy of the full text",
    contradictions: ["The king is both alive and dead"],
    checks: [{ ability: "", dc: 99 }],
    homebrew: { mechanics: [], balance: { risks: [], playtestChecks: [] } },
    gmScene: scene.gmScene,
    playerScene: unsafePlayer,
    latencyMs: 60_000,
    costMicros: 1_000_000,
  }, ["lore_consistency", "mechanics", "homebrew_balance", "copyright", "map_integrity", "latency", "cost"]);
  assert.equal(report.outcome, "fail");
  assert.equal(report.summary.failed, 7);
});
