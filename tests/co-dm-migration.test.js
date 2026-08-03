import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../supabase/migrations/20260803202500_dnd_ai_desktop_co_dm_policy.sql", import.meta.url);

test("desktop Co-DM has versioned mock and OpenAI production policies", async () => {
  const sql = await readFile(migration, "utf8");
  assert.match(sql, /'co_dm\.draft'/i);
  assert.match(sql, /'dnd-co-dm-draft'/i);
  assert.match(sql, /'fce64509f922302feafadd7a74e8cd741fa52376c9bee3eefce1770fbc9c110a'/i);
  assert.match(sql, /\('mock','deterministic-local'\)/i);
  assert.match(sql, /\('openai','\*'\)/i);
  assert.match(sql, /128000,8000,0,0,true,null/i);
  assert.doesNotMatch(sql, /voice|billing|payment/i);
});
