begin;

alter table public.dnd_sources
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists visibility text not null default 'manager_only',
  add column if not exists retrieval_enabled boolean not null default true;

alter table public.dnd_sources
  drop constraint if exists dnd_sources_visibility_check;
alter table public.dnd_sources
  add constraint dnd_sources_visibility_check
  check (visibility in ('manager_only','campaign_members'));

alter table public.dnd_content_entries
  add column if not exists visibility text not null default 'inherit';

alter table public.dnd_content_entries
  drop constraint if exists dnd_content_entries_visibility_check;
alter table public.dnd_content_entries
  add constraint dnd_content_entries_visibility_check
  check (visibility in ('inherit','manager_only','campaign_members'));

alter table public.dnd_content_entries
  drop constraint if exists dnd_content_entries_origin_check;
alter table public.dnd_content_entries
  add constraint dnd_content_entries_origin_check
  check (content_origin in (
    'metadata_only','user_authored','licensed_full_text','licensed_summary',
    'public_domain','partner_api','external_reference','campaign_generated'
  ));

alter table public.dnd_content_entries
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(name, '')), 'A') ||
    setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('pg_catalog.english'::regconfig, coalesce(full_text, '')), 'C')
  ) stored;

create index if not exists dnd_content_entries_search_idx
  on public.dnd_content_entries using gin (search_vector)
  where active;
create unique index if not exists dnd_content_entries_source_hash_unique
  on public.dnd_content_entries (source_id, content_hash)
  where active and content_hash <> '';
create index if not exists dnd_sources_created_by_idx
  on public.dnd_sources (created_by)
  where created_by is not null;
create index if not exists dnd_campaign_sources_enabled_lookup_idx
  on public.dnd_campaign_sources (campaign_id, source_id)
  where enabled;

commit;
