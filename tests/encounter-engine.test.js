import assert from "node:assert/strict";
import test from "node:test";
import { LocalEncounterEngine } from "../src/encounter-engine.js";

const CAMPAIGN_ID = "11111111-1111-4111-8111-111111111111";

function setup() {
  const engine = new LocalEncounterEngine();
  const created = engine.execute(CAMPAIGN_ID, "create_encounter", {
    name: "Ashen Crucible",
    sessionId: null,
    status: "draft",
    metadata: {},
  });
  const encounterId = created.encounterId;
  const first = engine.execute(CAMPAIGN_ID, "add_combatant", {
    encounterId,
    characterId: null,
    npcId: null,
    name: "Vorkesh",
    initiative: 18,
    dexterity: 14,
    hp: 20,
    maxHp: 20,
    tempHp: 5,
    armorClass: 17,
    hidden: false,
    team: "party",
    legendaryActionsMax: 0,
    isLairActor: false,
    metadata: {},
  }).result;
  const second = engine.execute(CAMPAIGN_ID, "add_combatant", {
    encounterId,
    characterId: null,
    npcId: null,
    name: "Forge Tyrant",
    initiative: 12,
    dexterity: 10,
    hp: 40,
    maxHp: 40,
    tempHp: 0,
    armorClass: 18,
    hidden: false,
    team: "enemy",
    legendaryActionsMax: 3,
    isLairActor: false,
    metadata: {},
  }).result;
  return { engine, encounterId, first, second };
}

test("damage consumes temporary HP before normal HP and healing respects maximum", () => {
  const { engine, first } = setup();
  const damaged = engine.execute(CAMPAIGN_ID, "apply_damage", {
    combatantId: first.id,
    amount: 8,
    damageType: "fire",
    source: "vent",
  }).result;
  assert.equal(damaged.absorbedByTempHp, 5);
  assert.equal(damaged.tempHp, 0);
  assert.equal(damaged.hp, 17);

  const healed = engine.execute(CAMPAIGN_ID, "heal", {
    combatantId: first.id,
    amount: 50,
    source: "repair infusion",
  }).result;
  assert.equal(healed.hp, 20);
});

test("conditions, concentration, reactions, and death saves are tracked", () => {
  const { engine, first } = setup();
  let result = engine.execute(CAMPAIGN_ID, "add_condition", {
    combatantId: first.id,
    condition: "restrained",
    details: { rounds: 2, source: "chains" },
  }).result;
  assert.deepEqual(result.conditions, ["restrained"]);
  assert.equal(result.conditionDetails.restrained.rounds, 2);

  result = engine.execute(CAMPAIGN_ID, "set_concentration", {
    combatantId: first.id,
    active: true,
    effect: "Heat Shield",
    source: "Artificer feature",
  }).result;
  assert.equal(result.concentration.active, true);

  result = engine.execute(CAMPAIGN_ID, "set_reaction", {
    combatantId: first.id,
    available: false,
  }).result;
  assert.equal(result.reactionAvailable, false);

  result = engine.execute(CAMPAIGN_ID, "record_death_save", {
    combatantId: first.id,
    outcome: "natural-1",
  }).result;
  assert.equal(result.deathSaveFailures, 2);

  result = engine.execute(CAMPAIGN_ID, "remove_condition", {
    combatantId: first.id,
    condition: "restrained",
  }).result;
  assert.deepEqual(result.conditions, []);
});

test("initiative order is stable and advancing a full cycle increments the round", () => {
  const { engine, encounterId, first, second } = setup();
  engine.execute(CAMPAIGN_ID, "set_reaction", {
    combatantId: second.id,
    available: false,
  });
  engine.execute(CAMPAIGN_ID, "set_legendary_actions", {
    combatantId: second.id,
    maximum: 3,
    remaining: 0,
  });
  engine.execute(CAMPAIGN_ID, "set_encounter_status", {
    encounterId,
    status: "active",
  });

  let result = engine.execute(CAMPAIGN_ID, "advance_turn", { encounterId }).result;
  assert.equal(result.encounter.currentTurnIndex, 1);
  const current = result.combatants.find((combatant) => combatant.id === second.id);
  assert.equal(current.reactionAvailable, true);
  assert.equal(current.legendaryActionsRemaining, 3);

  result = engine.execute(CAMPAIGN_ID, "advance_turn", { encounterId }).result;
  assert.equal(result.encounter.currentTurnIndex, 0);
  assert.equal(result.encounter.round, 2);
  assert.equal(result.combatants[0].id, first.id);
});

test("natural 20 death save restores one HP and clears death saves", () => {
  const { engine, first } = setup();
  engine.execute(CAMPAIGN_ID, "set_combatant_stats", {
    combatantId: first.id,
    hp: 0,
  });
  engine.execute(CAMPAIGN_ID, "record_death_save", {
    combatantId: first.id,
    outcome: "failure",
  });
  const result = engine.execute(CAMPAIGN_ID, "record_death_save", {
    combatantId: first.id,
    outcome: "natural-20",
  }).result;
  assert.equal(result.hp, 1);
  assert.equal(result.deathSaveSuccesses, 0);
  assert.equal(result.deathSaveFailures, 0);
});
