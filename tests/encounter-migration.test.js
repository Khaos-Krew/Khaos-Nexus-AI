import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stateMigration = new URL(
  "../supabase/migrations/20260803062500_dnd_ai_phase3_encounter_state.sql",
  import.meta.url,
);
const toolsMigration = new URL(
  "../supabase/migrations/20260803062510_dnd_ai_phase3_encounter_tools.sql",
  import.meta.url,
);

async function sql() {
  return `${await readFile(stateMigration, "utf8")}\n${await readFile(toolsMigration, "utf8")}`;
}

test("Phase 3 migration adds explicit combat-state fields and stable initiative ordering", async () => {
  const content = await sql();
  for (const column of [
    "temp_hp",
    "armor_class",
    "concentration",
    "reaction_available",
    "death_save_successes",
    "death_save_failures",
    "legendary_actions_max",
    "legendary_actions_remaining",
    "is_lair_actor",
    "revision",
  ]) {
    assert.match(content, new RegExp(`add column if not exists ${column}`, "i"));
  }
  assert.match(content, /initiative desc, dexterity desc, joined_at, id/i);
});

test("Phase 3 migration filters hidden combatants and restricts player mutations", async () => {
  const content = await sql();
  assert.match(content, /v_can_manage or not c\.hidden/i);
  assert.match(
    content,
    /v_owns_combatant and p_tool in \('set_concentration', 'set_reaction', 'record_death_save'\)/i,
  );
  assert.match(content, /not private\.dnd_can_view_campaign\(p_campaign_id\)/i);
  assert.match(content, /v_can_manage := private\.dnd_can_manage_campaign\(p_campaign_id\)/i);
  assert.match(content, /if not v_can_manage and not \(/i);
});

test("Phase 3 migration locks state, applies temporary HP, and audits every mutation", async () => {
  const content = await sql();
  assert.match(content, /for update/i);
  assert.match(content, /v_absorbed:=least\(v_combatant\.temp_hp,v_amount\)/i);
  assert.match(content, /hp=greatest\(0,c\.hp-\(v_amount-v_absorbed\)\)/i);
  assert.match(content, /legendary_actions_remaining=legendary_actions_max/i);
  assert.match(content, /'ai\.encounter\.'\|\|p_tool/i);
  assert.match(content, /insert into public\.dnd_audit_log/i);
});

test("Phase 3 encounter functions are authenticated-only and use a fixed allow-list", async () => {
  const content = await sql();
  for (const tool of [
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
  ]) {
    assert.match(content, new RegExp(`when '${tool}'`, "i"));
  }
  assert.match(
    content,
    /revoke all on function public\.dnd_ai_execute_encounter_tool\(uuid,text,jsonb\) from public,anon/i,
  );
  assert.match(
    content,
    /revoke all on function public\.dnd_ai_encounter_state\(uuid,uuid\) from public,anon/i,
  );
  assert.doesNotMatch(content, /execute\s+format/i);
  assert.doesNotMatch(content, /grant execute[^;]+to anon/i);
});
