import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrls = [
  new URL("../supabase/migrations/20260803170000_dnd_ai_phase7_map_scene_schema.sql", import.meta.url),
  new URL("../supabase/migrations/20260803170010_dnd_ai_phase7_map_scene_rpcs.sql", import.meta.url),
];

async function sql() {
  return (await Promise.all(migrationUrls.map((url) => readFile(url, "utf8")))).join("\n");
}

test("Phase 7 creates revisioned map scene storage with RLS and indexes", async () => {
  const content = await sql();
  assert.match(content, /create table if not exists public\.dnd_map_scenes/i);
  assert.match(content, /campaign_id uuid not null references public\.dnd_campaigns\(id\) on delete cascade/i);
  assert.match(content, /gm_scene jsonb not null/i);
  assert.match(content, /player_scene jsonb not null/i);
  assert.match(content, /revision integer not null default 0/i);
  assert.match(content, /alter table public\.dnd_map_scenes enable row level security/i);
  assert.match(content, /revoke all on table public\.dnd_map_scenes from anon, authenticated/i);
  assert.match(content, /dnd_map_scenes_campaign_updated_idx/i);
  assert.match(content, /dnd_map_scenes_approved_by_idx/i);
});

test("Phase 7 player projection helper rejects every secret-bearing collection", async () => {
  const content = await sql();
  for (const path of [
    "walls[*] ? (@.secret == true)",
    "doors[*] ? (@.secret == true)",
    "windows[*] ? (@.secret == true)",
    "terrain[*] ? (@.hidden == true)",
    "lights[*] ? (@.hidden == true)",
    "tokens[*] ? (@.hidden == true)",
    "pointsOfInterest[*] ? (@.secret == true || @.revealed == false)",
    "fogRegions[*] ? (@.revealed == false)",
  ]) {
    assert.ok(content.includes(path), `missing player-scene filter: ${path}`);
  }
  assert.match(content, /coalesce\(p_scene ->> 'gmNotes', ''\) = ''/i);
  assert.match(content, /@\.gmNotes != ""/i);
});

test("Phase 7 saves and approvals are manager-only, revision-locked, and audited", async () => {
  const content = await sql();
  assert.match(content, /private\.dnd_can_manage_campaign\(p_campaign_id\)/i);
  assert.match(content, /for update/i);
  assert.match(content, /v_scene\.revision <> p_expected_revision/i);
  assert.match(content, /approved_by = null/i);
  assert.match(content, /approved_at = null/i);
  assert.match(content, /ai\.map_scene\.saved/i);
  assert.match(content, /ai\.map_scene\.approved/i);
  assert.match(content, /insert into public\.dnd_audit_log/i);
});

test("Phase 7 validates projection identity, size, and source hashes", async () => {
  const content = await sql();
  assert.match(content, /p_gm_scene ->> 'projection' <> 'gm'/i);
  assert.match(content, /private\.dnd_ai_player_scene_is_safe\(p_player_scene\)/i);
  assert.match(content, /p_gm_scene ->> 'id' is distinct from p_player_scene ->> 'id'/i);
  assert.match(content, /p_gm_scene ->> 'sourceMapHash' is distinct from p_player_scene ->> 'sourceMapHash'/i);
  assert.match(content, /octet_length\(p_gm_scene::text\) > 1500000/i);
  assert.match(content, /extensions\.digest\(p_gm_scene::text, 'sha256'\)/i);
});

test("Phase 7 hides drafts and GM payloads from non-managers", async () => {
  const content = await sql();
  assert.match(content, /not v_can_manage and v_scene\.approved_at is null/i);
  assert.match(content, /case when v_can_manage then v_scene\.source_map else null end/i);
  assert.match(content, /case when v_can_manage then v_scene\.gm_scene else null end/i);
  assert.match(content, /v_can_manage or s\.approved_at is not null/i);
});

test("Phase 7 public and private RPCs deny anonymous execution", async () => {
  const content = await sql();
  const signatures = [
    "dnd_ai_map_scenes\\(uuid\\)",
    "dnd_ai_map_scene\\(uuid,uuid\\)",
    "dnd_ai_save_map_scene\\(uuid,uuid,text,jsonb,jsonb,jsonb,integer\\)",
    "dnd_ai_approve_map_scene\\(uuid,uuid,integer\\)",
  ];
  for (const signature of signatures) {
    assert.match(content, new RegExp(`revoke all on function public\\.${signature} from public, anon`, "i"));
    assert.match(content, new RegExp(`revoke all on function private\\.${signature} from public, anon`, "i"));
    assert.match(content, new RegExp(`grant execute on function public\\.${signature} to authenticated`, "i"));
  }
  assert.match(content, /revoke all on function private\.dnd_ai_player_scene_is_safe\(jsonb\) from public, anon/i);
  assert.doesNotMatch(content, /grant execute[^;]+to anon/i);
});
