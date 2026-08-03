import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/20260803155500_dnd_ai_phase5_session_intelligence.sql",
  import.meta.url,
);

async function sql() {
  return readFile(migrationUrl, "utf8");
}

test("Phase 5 migration adds revisioned intelligence fields", async () => {
  const content = await sql();
  for (const column of [
    "intelligence_draft",
    "intelligence_revision",
    "intelligence_approved_by",
    "intelligence_approved_at",
    "intelligence_updated_at",
  ]) {
    assert.match(content, new RegExp(`add column if not exists ${column}`, "i"));
  }
  assert.match(content, /check \(intelligence_revision >= 0\)/i);
});

test("Phase 5 migration filters player output and never exposes GM recap", async () => {
  const content = await sql();
  assert.match(content, /dnd_ai_public_session_intelligence/i);
  assert.match(content, /where coalesce\(\(item\.value ->> 'public'\)::boolean, false\)/i);
  const publicFunction = content.split("create or replace function private.dnd_ai_session_intelligence")[0];
  assert.doesNotMatch(publicFunction, /gmRecap/);
  assert.doesNotMatch(publicFunction, /contradictions/);
  assert.doesNotMatch(publicFunction, /nextSessionPrep/);
});

test("Phase 5 saves and approvals are manager-only, revision-locked, and audited", async () => {
  const content = await sql();
  assert.match(content, /private\.dnd_can_manage_campaign\(p_campaign_id\)/i);
  assert.match(content, /for update/i);
  assert.match(content, /intelligence_revision <> p_expected_revision/i);
  assert.match(content, /intelligence_approved_by = null/i);
  assert.match(content, /recap_approved_by = null/i);
  assert.match(content, /'ai\.session_intelligence\.saved'/i);
  assert.match(content, /'ai\.session_intelligence\.approved'/i);
  assert.match(content, /insert into public\.dnd_audit_log/i);
});

test("Phase 5 public RPCs are authenticated-only", async () => {
  const content = await sql();
  for (const signature of [
    "dnd_ai_session_intelligence\\(uuid,uuid\\)",
    "dnd_ai_save_session_intelligence\\(uuid,uuid,jsonb,integer\\)",
    "dnd_ai_approve_session_intelligence\\(uuid,uuid,integer\\)",
  ]) {
    assert.match(content, new RegExp(`revoke all on function public\\.${signature} from public, anon`, "i"));
    assert.match(content, new RegExp(`grant execute on function public\\.${signature} to authenticated`, "i"));
  }
  assert.doesNotMatch(content, /grant execute[^;]+to anon/i);
});
