import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bindingMigration = new URL(
  "../supabase/migrations/20260803064000_dnd_ai_phase4_discord_bindings.sql",
  import.meta.url,
);
const contextMigration = new URL(
  "../supabase/migrations/20260803064010_dnd_ai_phase4_discord_context.sql",
  import.meta.url,
);
const authorizationMigration = new URL(
  "../supabase/migrations/20260803064020_dnd_ai_phase4_binding_list_authorization.sql",
  import.meta.url,
);

async function sql() {
  return [bindingMigration, contextMigration, authorizationMigration]
    .reduce(async (promise, file) => `${await promise}\n${await readFile(file, "utf8")}`, "");
}

test("Phase 4 binds only managed apps and existing text resources", async () => {
  const content = await sql();
  assert.match(content, /private\.dnd_user_can_manage_app\(p_registered_app_id\)/i);
  assert.match(content, /Discord app and campaign must belong to the same tenant/i);
  assert.match(content, /Discord app is disabled/i);
  assert.match(content, /Voice bindings are deferred and cannot be created/i);
  assert.doesNotMatch(content, /create channel|create category|discord\.js/i);
});

test("Phase 4 command context requires verified bindings and exact linked actors", async () => {
  const content = await sql();
  assert.match(content, /b\.verified_at is not null/i);
  assert.match(content, /b\.registered_app_id = p_registered_app_id/i);
  assert.match(content, /b\.guild_id = p_guild_id/i);
  assert.match(content, /b\.resource_id = p_resource_id/i);
  assert.match(content, /m\.user_id = auth\.uid\(\)/i);
  assert.match(content, /m\.discord_user_id = p_discord_user_id/i);
  assert.match(content, /m\.active/i);
});

test("Phase 4 binding changes are audited and authenticated-only", async () => {
  const content = await sql();
  assert.match(content, /ai\.discord\.binding\.upsert/i);
  assert.match(content, /ai\.discord\.binding\.verify/i);
  assert.match(content, /insert into public\.dnd_audit_log/i);
  for (const functionName of [
    "dnd_ai_discord_bindings",
    "dnd_ai_upsert_discord_binding",
    "dnd_ai_verify_discord_binding",
    "dnd_ai_discord_context",
  ]) {
    assert.match(content, new RegExp(`grant execute on function public\\.${functionName}`, "i"));
  }
  assert.doesNotMatch(content, /grant execute[^;]+to anon/i);
});

test("unauthorized binding lists raise an error instead of returning an empty result", async () => {
  const content = await readFile(authorizationMigration, "utf8");
  assert.match(content, /Campaign management access denied/i);
  assert.match(content, /raise exception/i);
});
