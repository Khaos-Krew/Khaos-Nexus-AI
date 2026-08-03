import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrls = [
  new URL(
    "../supabase/migrations/20260803155500_dnd_ai_phase5_session_intelligence.sql",
    import.meta.url,
  ),
  new URL(
    "../supabase/migrations/20260803155600_dnd_ai_phase5_session_intelligence_hardening.sql",
    import.meta.url,
  ),
  new URL(
    "../supabase/migrations/20260803155700_dnd_ai_phase5_private_function_grants.sql",
    import.meta.url,
  ),
];

async function sql() {
  return (await Promise.all(migrationUrls.map((url) => readFile(url, "utf8")))).join("\n");
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

test("Phase 5 rebuilds a minimal player projection from safe JSON types", async () => {
  const content = await sql();
  assert.match(content, /dnd_ai_public_session_intelligence/i);
  assert.match(content, /item\.value -> 'public' = 'true'::jsonb/i);
  assert.match(content, /jsonb_typeof\(p_draft -> 'canonFacts'\) = 'array'/i);
  assert.match(content, /jsonb_typeof\(p_draft -> 'unresolvedThreads'\) = 'array'/i);
  assert.match(content, /jsonb_build_object\(\s*'statement'/i);
  assert.match(content, /jsonb_build_object\(\s*'thread'/i);
  const hardenedPublicFunction = content.split(
    "create or replace function private.dnd_ai_save_session_intelligence",
  )[0].split("create or replace function private.dnd_ai_public_session_intelligence").at(-1);
  assert.doesNotMatch(hardenedPublicFunction, /gmRecap/);
  assert.doesNotMatch(hardenedPublicFunction, /evidence/);
  assert.doesNotMatch(hardenedPublicFunction, /notes/);
  assert.doesNotMatch(hardenedPublicFunction, /nextSessionPrep/);
});

test("Phase 5 validates field types and size limits inside PostgreSQL", async () => {
  const content = await sql();
  assert.match(content, /p_intelligence ->> 'version' <> '1'/i);
  assert.match(content, /jsonb_typeof\(p_intelligence -> 'gmRecap'\) <> 'string'/i);
  assert.match(content, /jsonb_typeof\(p_intelligence -> 'canonFacts'\) <> 'array'/i);
  assert.match(content, /jsonb_typeof\(p_intelligence -> 'nextSessionPrep'\) <> 'object'/i);
  assert.match(content, /octet_length\(p_intelligence::text\) > 160000/i);
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

test("Phase 5 public and private RPCs deny anonymous execution", async () => {
  const content = await sql();
  for (const signature of [
    "dnd_ai_session_intelligence\\(uuid,uuid\\)",
    "dnd_ai_save_session_intelligence\\(uuid,uuid,jsonb,integer\\)",
    "dnd_ai_approve_session_intelligence\\(uuid,uuid,integer\\)",
  ]) {
    assert.match(content, new RegExp(`revoke all on function public\\.${signature} from public, anon`, "i"));
    assert.match(content, new RegExp(`grant execute on function public\\.${signature} to authenticated`, "i"));
    assert.match(content, new RegExp(`revoke all on function private\\.${signature} from public, anon`, "i"));
  }
  assert.match(
    content,
    /revoke all on function private\.dnd_ai_public_session_intelligence\(jsonb\) from public, anon/i,
  );
  assert.doesNotMatch(content, /grant execute[^;]+to anon/i);
});
