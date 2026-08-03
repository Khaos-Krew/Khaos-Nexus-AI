import assert from "node:assert/strict";
import test from "node:test";
import {
  encounterToolDefinitions,
  validateEncounterToolRequest,
} from "../src/encounter-tools.js";

const COMBATANT_ID = "11111111-1111-4111-8111-111111111111";
const ENCOUNTER_ID = "22222222-2222-4222-8222-222222222222";

test("encounter discovery exposes the fixed 16-tool allow-list", () => {
  assert.deepEqual(
    encounterToolDefinitions.map((tool) => tool.name),
    [
      "create_encounter",
      "set_encounter_status",
      "add_combatant",
      "set_initiative",
      "advance_turn",
      "rewind_turn",
      "apply_damage",
      "heal",
      "set_combatant_stats",
      "add_condition",
      "remove_condition",
      "set_concentration",
      "set_reaction",
      "record_death_save",
      "set_legendary_actions",
      "set_combatant_visibility",
    ],
  );
});

test("add combatant preserves omitted HP and armor fields for server-side inheritance", () => {
  const result = validateEncounterToolRequest({
    tool: "add_combatant",
    arguments: {
      encounterId: ENCOUNTER_ID,
      characterId: COMBATANT_ID,
      initiative: 18,
      dexterity: 14,
    },
  });
  assert.equal(result.arguments.characterId, COMBATANT_ID);
  assert.equal(Object.hasOwn(result.arguments, "hp"), false);
  assert.equal(Object.hasOwn(result.arguments, "maxHp"), false);
  assert.equal(Object.hasOwn(result.arguments, "armorClass"), false);
});

test("required combat mutation values cannot silently default", () => {
  assert.throws(
    () => validateEncounterToolRequest({
      tool: "apply_damage",
      arguments: { combatantId: COMBATANT_ID },
    }),
    /amount is required/i,
  );
  assert.throws(
    () => validateEncounterToolRequest({
      tool: "set_initiative",
      arguments: { combatantId: COMBATANT_ID, initiative: 17 },
    }),
    /dexterity is required/i,
  );
  assert.throws(
    () => validateEncounterToolRequest({
      tool: "set_reaction",
      arguments: { combatantId: COMBATANT_ID },
    }),
    /available is required/i,
  );
});

test("visibility mutation requires explicit hidden and active state", () => {
  assert.throws(
    () => validateEncounterToolRequest({
      tool: "set_combatant_visibility",
      arguments: { combatantId: COMBATANT_ID, hidden: true },
    }),
    /active is required/i,
  );

  const result = validateEncounterToolRequest({
    tool: "set_combatant_visibility",
    arguments: { combatantId: COMBATANT_ID, hidden: true, active: false },
  });
  assert.deepEqual(result.arguments, {
    combatantId: COMBATANT_ID,
    hidden: true,
    active: false,
  });
});

test("unknown tools and undeclared fields are rejected", () => {
  assert.throws(
    () => validateEncounterToolRequest({ tool: "run_sql", arguments: {} }),
    /Unsupported encounter tool/i,
  );
  assert.throws(
    () => validateEncounterToolRequest({
      tool: "heal",
      arguments: { combatantId: COMBATANT_ID, amount: 5, overrideAuthorization: true },
    }),
    /not allowed/i,
  );
});
