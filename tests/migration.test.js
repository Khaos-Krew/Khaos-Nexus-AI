import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = new URL(
  "../supabase/migrations/20260803054500_dnd_ai_phase1_auth_rls.sql",
  import.meta.url,
);

test("Phase 1 migration fixes combatant ownership and homebrew approval policies", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /c\.campaign_id = dnd_encounter_combatants\.campaign_id/i);
  assert.doesNotMatch(sql, /c\.campaign_id = c\.campaign_id/i);
  assert.match(sql, /status in \('draft', 'submitted'\)/i);
  assert.match(sql, /approved_by is null/i);
  assert.match(sql, /approved_at is null/i);
});

test("Phase 1 migration exposes only authenticated RPC wrappers", async () => {
  const sql = await readFile(migrationPath, "utf8");
  for (const functionName of [
    "dnd_campaign_list",
    "dnd_campaign_workspace",
    "dnd_ai_create_campaign",
    "dnd_ai_update_campaign_state",
    "dnd_ai_create_homebrew",
    "dnd_ai_approve_homebrew",
  ]) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${functionName}`, "i"));
  }
  assert.match(sql, /revoke all on function public\.dnd_campaign_workspace\(uuid\) from public, anon/i);
  assert.doesNotMatch(sql, /grant execute[^;]+to anon/i);
  assert.doesNotMatch(sql, /service_role/i);
});

test("Phase 1 migration provides filtered player-facing workspace collections", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /v_can_manage or n\.revealed/i);
  assert.match(sql, /v_can_manage or l\.revealed/i);
  assert.match(sql, /v_can_manage or f\.revealed/i);
  assert.match(sql, /v_can_manage or q\.visible_to_players/i);
  assert.match(sql, /v_can_manage or s\.recap_approved_at is not null/i);
  assert.match(sql, /v_can_manage or not ec\.hidden/i);
});
