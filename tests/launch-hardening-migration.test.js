import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/20260804014500_dnd_ai_launch_hardening.sql", import.meta.url);
const grantsUrl = new URL("../supabase/migrations/20260804014600_dnd_ai_launch_hardening_grants.sql", import.meta.url);

test("launch migration requires explicit stateless tenant scope", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /dnd_ai_scope_tenant_explicit/);
  assert.match(sql, /An explicit tenant is required for stateless generation/);
  assert.match(sql, /nexus_tenant_role\(p_tenant_id\) is null/);
  assert.match(sql, /Tenant and campaign do not match/);
});

test("OpenAI reservations require a matching active budget", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /p_provider = 'openai' and v_matching_budgets = 0/);
  assert.match(sql, /budget_required/);
  assert.match(sql, /for update/);
});

test("launch pricing is exact-model and zero-priced wildcards are disabled", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /model_pattern = '\*'/);
  assert.match(sql, /set active = false/);
  assert.match(sql, /'gpt-5-mini'/);
  assert.match(sql, /250000/);
  assert.match(sql, /2000000/);
  assert.match(sql, /'launch-1'/);
});

test("v2 reservation functions deny anonymous execution", async () => {
  const sql = `${await readFile(migrationUrl, "utf8")}\n${await readFile(grantsUrl, "utf8")}`;
  assert.match(sql, /revoke all on function public\.dnd_ai_reserve_generation_v2[\s\S]*from public, anon/);
  assert.match(sql, /grant execute on function public\.dnd_ai_reserve_generation_v2[\s\S]*to authenticated/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /set search_path=public,private,pg_temp/);
});
