import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrls = [
  "20260803163000_dnd_ai_phase6_retrieval_schema.sql",
  "20260803163010_dnd_ai_phase6_retrieval_sources.sql",
  "20260803163020_dnd_ai_phase6_retrieval_entries.sql",
  "20260803163030_dnd_ai_phase6_retrieval_search.sql",
  "20260803163040_dnd_ai_phase6_retrieval_rpc_grants.sql",
].map((name) => new URL(`../supabase/migrations/${name}`, import.meta.url));

async function sql() {
  return (await Promise.all(migrationUrls.map((url) => readFile(url, "utf8")))).join("\n");
}

test("Phase 6 adds licensed visibility fields, generated search vectors, and deduplication", async () => {
  const content = await sql();
  assert.match(content, /add column if not exists created_by uuid references auth\.users/i);
  assert.match(content, /add column if not exists visibility text not null default 'manager_only'/i);
  assert.match(content, /add column if not exists retrieval_enabled boolean not null default true/i);
  assert.match(content, /add column if not exists search_vector tsvector\s+generated always as/i);
  assert.match(content, /using gin \(search_vector\)/i);
  assert.match(content, /dnd_content_entries_source_hash_unique/i);
  assert.match(content, /where active and content_hash <> ''/i);
});

test("Phase 6 source management requires managers and explicit license evidence", async () => {
  const content = await sql();
  assert.match(content, /private\.dnd_can_manage_campaign\(p_campaign_id\)/i);
  assert.match(content, /Attribution is required for SRD CC BY sources/i);
  assert.match(content, /rights or entitlement reference is required/i);
  assert.match(content, /external reference URL is required/i);
  assert.match(
    content,
    /and\s+p_license_type\s+in\s*\('srd_cc_by','user_authored','user_supplied_private','partner_api'\)/i,
  );
  assert.match(content, /ai\.retrieval\.source_upserted/i);
});

test("Phase 6 ingestion enforces tenant, origin, full-text, size, hash, and audit rules", async () => {
  const content = await sql();
  assert.match(content, /Source and campaign tenants do not match/i);
  assert.match(content, /Global sources cannot be edited through the campaign API/i);
  assert.match(content, /length\(coalesce\(p_full_text,''\)\) > 50000/i);
  assert.match(content, /Metadata-only entries cannot contain full text/i);
  assert.match(content, /Partner API content requires a partner API source/i);
  assert.match(content, /External reference content requires an external-link source/i);
  assert.match(content, /Restricted sources may store summaries and metadata only/i);
  assert.match(content, /v_hash\s*:=\s*md5/i);
  assert.match(content, /content_hash\s*=\s*v_hash\s+and\s+active/i);
  assert.match(content, /ai\.retrieval\.entry_upserted/i);
});

test("Phase 6 search is campaign-scoped, visibility-filtered, cited, and excerpt-limited", async () => {
  const content = await sql();
  assert.match(content, /cs\.campaign_id\s*=\s*p_campaign_id\s+and\s+cs\.enabled/i);
  assert.match(content, /v_can_manage\s+or\s+s\.visibility\s*=\s*'campaign_members'/i);
  assert.match(content, /e\.visibility\s*=\s*'campaign_members'/i);
  assert.match(content, /h\.status\s*=\s*'approved'\s+or\s+v_can_manage/i);
  assert.match(content, /v_can_manage\s+or\s+s\.intelligence_approved_at\s+is\s+not\s+null/i);
  assert.match(content, /left\(case[\s\S]+end,\s*700\)\s+as\s+excerpt/i);
  assert.match(content, /'source:'\s*\|\|\s*s\.id::text\s*\|\|\s*':entry:'\s*\|\|\s*e\.id::text/i);
  assert.match(content, /'homebrew:'\s*\|\|\s*h\.id::text\s*\|\|\s*':revision:'\s*\|\|\s*h\.revision::text/i);
  assert.match(content, /'session:'\s*\|\|\s*s\.id::text\s*\|\|\s*':intelligence:'\s*\|\|\s*s\.intelligence_revision::text/i);
  assert.match(content, /greatest\(1,\s*least\(coalesce\(p_limit,8\),\s*10\)\)/i);
});

test("Phase 6 rejects reconstruction searches and audits only a query hash", async () => {
  const content = await sql();
  assert.match(content, /Retrieval cannot be used to reconstruct or export source text/i);
  for (const safeguard of ["verbatim", "exact[ -]?copy", "full[ -]?text", "reconstruct", "continue[ ]+from"]) {
    assert.ok(content.includes(safeguard), `missing reconstruction safeguard: ${safeguard}`);
  }
  assert.match(content, /'queryHash',\s*md5\(v_query\)/i);
  assert.match(content, /'resultCount',\s*jsonb_array_length\(v_results\)/i);
  assert.match(content, /ai\.retrieval\.searched/i);
});

test("Phase 6 public and private RPCs deny anonymous execution", async () => {
  const content = await sql();
  const signatures = [
    "dnd_ai_retrieval_sources\\(uuid\\)",
    "dnd_ai_upsert_retrieval_source\\(uuid,uuid,text,text,text,text,text,text,text,boolean,text,boolean\\)",
    "dnd_ai_upsert_retrieval_entry\\(uuid,uuid,uuid,text,text,text,text,text,text,jsonb\\)",
    "dnd_ai_search_retrieval\\(uuid,text,integer\\)",
  ];
  for (const signature of signatures) {
    assert.match(content, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${signature}\\s+from\\s+public,\\s*anon`, "i"));
    assert.match(content, new RegExp(`revoke\\s+all\\s+on\\s+function\\s+private\\.${signature}\\s+from\\s+public,\\s*anon`, "i"));
    assert.match(content, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${signature}\\s+to\\s+authenticated`, "i"));
  }
  assert.doesNotMatch(content, /grant execute[^;]+to anon/i);
});
