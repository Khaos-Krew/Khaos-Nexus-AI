begin;

create table if not exists public.dnd_map_scenes (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null references public.dnd_campaigns(id) on delete cascade,
  name text not null,
  source_map jsonb not null default '{}'::jsonb,
  gm_scene jsonb not null default '{}'::jsonb,
  player_scene jsonb not null default '{}'::jsonb,
  revision integer not null default 0,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid not null references auth.users(id) on delete restrict,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dnd_map_scenes_name_check check (char_length(name) between 1 and 300),
  constraint dnd_map_scenes_revision_check check (revision >= 0),
  constraint dnd_map_scenes_json_check check (
    jsonb_typeof(source_map) = 'object' and
    jsonb_typeof(gm_scene) = 'object' and
    jsonb_typeof(player_scene) = 'object' and
    jsonb_typeof(metadata) = 'object'
  )
);

alter table public.dnd_map_scenes enable row level security;

revoke all on table public.dnd_map_scenes from anon, authenticated;

create index if not exists dnd_map_scenes_campaign_updated_idx
  on public.dnd_map_scenes (campaign_id, updated_at desc)
  where active;
create index if not exists dnd_map_scenes_approved_by_idx
  on public.dnd_map_scenes (approved_by)
  where approved_by is not null;
create unique index if not exists dnd_map_scenes_campaign_name_unique
  on public.dnd_map_scenes (campaign_id, lower(name))
  where active;

commit;
