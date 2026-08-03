import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = [
  "20260803194000_dnd_ai_phase8_production_schema.sql",
  "20260803194010_dnd_ai_phase8_policy_budget_rpcs.sql",
  "20260803194020_dnd_ai_phase8_usage_reservation_rpcs.sql",
  "20260803194025_dnd_ai_phase8_monitoring_evaluation_rpcs.sql",
  "20260803194030_dnd_ai_phase8_seed_and_grants.sql",
  "20260803194040_dnd_ai_phase8_foreign_key_indexes.sql",
].map((name) => new URL(`../supabase/migrations/${name}`, import.meta.url));

async function sql() {
  return (await Promise.all(files.map((url) => readFile(url, "utf8")))).join("\n");
}

test("Phase 8 creates RPC-only policy, budget, usage, and evaluation tables", async () => {
  const content = await sql();
  for (const table of ["dnd_ai_model_policies", "dnd_ai_budgets", "dnd_ai_usage_events", "dnd_ai_evaluation_runs"]) {
    assert.match(content, new RegExp(`create table if not exists public\\.${table}`, "i"));
    assert.match(content, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
    assert.match(content, new RegExp(`create policy ${table}_rpc_only`, "i"));
    assert.match(content, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, "i"));
  }
});

test("reservations are idempotent, fail closed, and row-lock matching budgets", async () => {
  const content = await sql();
  assert.match(content, /request_id uuid not null unique/i);
  assert.match(content, /status text not null check \(status in \('reserved','succeeded','failed','blocked'\)\)/i);
  assert.match(content, /for update/i);
  assert.match(content, /model_policy_not_found/i);
  assert.match(content, /request_limit/i);
  assert.match(content, /input_token_limit/i);
  assert.match(content, /output_token_limit/i);
  assert.match(content, /cost_limit/i);
  assert.match(content, /exception when unique_violation/i);
});

test("monitoring stores hashes and bounded metrics instead of raw prompts or outputs", async () => {
  const content = await sql();
  assert.match(content, /input_hash text not null/i);
  assert.match(content, /output_hash text/i);
  assert.match(content, /prompt_hash text not null/i);
  assert.match(content, /latency_ms integer/i);
  assert.match(content, /evaluation_summary jsonb/i);
  assert.doesNotMatch(content, /raw_prompt|raw_output|prompt_text|output_text/i);
});

test("model policies pin every prompt hash and do not hard-code provider prices", async () => {
  const content = await sql();
  for (const hash of [
    "20fe5de9bbe328bc416b5a3ce016dac63d511d544918696e763b7cf714cb47a4",
    "7094e5d0003d3b8e710c2e6ccd02ca53f81ff6c00ff6d776a0ad21fc48653271",
    "b39ec18456f95ed7826952a9c5e7fce5e04ef6db4b7b95b178455043563282c1",
    "cba73b874a8e5b6075965315df186a5e654c36e4cd5f69b8dd8580a3044bc26e",
  ]) assert.ok(content.includes(hash));
  assert.match(content, /input_cost_micros_per_million bigint not null default 0/i);
  assert.match(content, /output_cost_micros_per_million bigint not null default 0/i);
});

test("all public production RPCs deny anonymous execution and grant authenticated callers", async () => {
  const content = await sql();
  for (const name of [
    "dnd_ai_generation_policy", "dnd_ai_budgets", "dnd_ai_upsert_budget",
    "dnd_ai_model_policies", "dnd_ai_upsert_model_policy", "dnd_ai_reserve_generation",
    "dnd_ai_finalize_generation", "dnd_ai_usage", "dnd_ai_save_evaluation", "dnd_ai_evaluations",
  ]) {
    assert.match(content, new RegExp(`revoke all on function public\\.${name}\\(`, "i"));
    assert.match(content, new RegExp(`grant execute on function public\\.${name}\\(`, "i"));
  }
  assert.doesNotMatch(content, /grant execute[^;]+to anon/i);
});

test("Phase 8 includes audit events and covering foreign-key indexes", async () => {
  const content = await sql();
  assert.match(content, /ai\.budget\.upserted/i);
  assert.match(content, /ai\.model_policy\.upserted/i);
  for (const index of [
    "dnd_ai_budgets_created_by_idx", "dnd_ai_evaluation_runs_user_idx",
    "dnd_ai_model_policies_created_by_idx", "dnd_ai_model_policies_tenant_idx",
    "dnd_ai_usage_events_policy_idx",
  ]) assert.ok(content.includes(index));
});
