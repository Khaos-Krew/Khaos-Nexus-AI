import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../supabase/migrations/20260803061000_dnd_ai_phase2_workspace_tools.sql",
  import.meta.url,
);

test("Phase 2 migration uses a fixed workspace tool allow-list", async () => {
  const sql = await readFile(migration, "utf8");
  for (const tool of [
    "upsert_npc", "upsert_location", "upsert_faction", "upsert_quest",
    "upsert_loot", "upsert_session", "approve_session_recap", "upsert_calendar_event",
  ]) assert.match(sql, new RegExp(`when '${tool}'`, "i"));
  assert.match(sql, /Unsupported workspace tool/i);
  assert.doesNotMatch(sql, /execute\s+format/i);
});

test("Phase 2 migration requires managers and audits mutations", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /not private\.dnd_can_manage_campaign\(p_campaign_id\)/i);
  assert.match(sql, /insert into public\.dnd_audit_log/i);
  assert.match(sql, /'ai\.workspace\.' \|\| p_tool/i);
  assert.match(sql, /revoke all on function public\.dnd_ai_execute_workspace_tool\(uuid,text,jsonb\) from public, anon/i);
  assert.doesNotMatch(sql, /grant execute[^;]+to anon/i);
});

test("Phase 2 migration protects campaign references and recap approval", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /Assigned character is not in this campaign/i);
  assert.match(sql, /Session is not in this campaign/i);
  assert.match(sql, /recap_approved_by\s*=\s*case\s*when s\.recap_draft is distinct from excluded\.recap_draft then null/i);
  assert.match(sql, /recap_approved_by\s*=\s*auth\.uid\(\)/i);
});
