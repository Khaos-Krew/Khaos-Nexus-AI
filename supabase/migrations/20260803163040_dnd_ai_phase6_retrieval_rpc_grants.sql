begin;

create or replace function public.dnd_ai_retrieval_sources(p_campaign_id uuid)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_retrieval_sources(p_campaign_id);
$function$;

create or replace function public.dnd_ai_upsert_retrieval_source(
  p_campaign_id uuid,
  p_source_id uuid,
  p_name text,
  p_ruleset text,
  p_source_version text,
  p_license_type text,
  p_license_reference text,
  p_attribution_text text,
  p_external_reference_url text,
  p_full_text_allowed boolean,
  p_visibility text,
  p_enabled boolean
)
returns jsonb
language sql
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_upsert_retrieval_source(
    p_campaign_id, p_source_id, p_name, p_ruleset, p_source_version,
    p_license_type, p_license_reference, p_attribution_text,
    p_external_reference_url, p_full_text_allowed, p_visibility, p_enabled
  );
$function$;

create or replace function public.dnd_ai_upsert_retrieval_entry(
  p_campaign_id uuid,
  p_source_id uuid,
  p_entry_id uuid,
  p_content_type text,
  p_name text,
  p_summary text,
  p_full_text text,
  p_content_origin text,
  p_visibility text,
  p_metadata jsonb
)
returns jsonb
language sql
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_upsert_retrieval_entry(
    p_campaign_id, p_source_id, p_entry_id, p_content_type, p_name,
    p_summary, p_full_text, p_content_origin, p_visibility, p_metadata
  );
$function$;

create or replace function public.dnd_ai_search_retrieval(
  p_campaign_id uuid,
  p_query text,
  p_limit integer default 8
)
returns jsonb
language sql
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_search_retrieval(p_campaign_id, p_query, p_limit);
$function$;

revoke all on function public.dnd_ai_retrieval_sources(uuid) from public, anon;
revoke all on function public.dnd_ai_upsert_retrieval_source(uuid,uuid,text,text,text,text,text,text,text,boolean,text,boolean) from public, anon;
revoke all on function public.dnd_ai_upsert_retrieval_entry(uuid,uuid,uuid,text,text,text,text,text,text,jsonb) from public, anon;
revoke all on function public.dnd_ai_search_retrieval(uuid,text,integer) from public, anon;
revoke all on function private.dnd_ai_retrieval_sources(uuid) from public, anon;
revoke all on function private.dnd_ai_upsert_retrieval_source(uuid,uuid,text,text,text,text,text,text,text,boolean,text,boolean) from public, anon;
revoke all on function private.dnd_ai_upsert_retrieval_entry(uuid,uuid,uuid,text,text,text,text,text,text,jsonb) from public, anon;
revoke all on function private.dnd_ai_search_retrieval(uuid,text,integer) from public, anon;

grant execute on function public.dnd_ai_retrieval_sources(uuid) to authenticated;
grant execute on function public.dnd_ai_upsert_retrieval_source(uuid,uuid,text,text,text,text,text,text,text,boolean,text,boolean) to authenticated;
grant execute on function public.dnd_ai_upsert_retrieval_entry(uuid,uuid,uuid,text,text,text,text,text,text,jsonb) to authenticated;
grant execute on function public.dnd_ai_search_retrieval(uuid,text,integer) to authenticated;
grant execute on function private.dnd_ai_retrieval_sources(uuid) to authenticated;
grant execute on function private.dnd_ai_upsert_retrieval_source(uuid,uuid,text,text,text,text,text,text,text,boolean,text,boolean) to authenticated;
grant execute on function private.dnd_ai_upsert_retrieval_entry(uuid,uuid,uuid,text,text,text,text,text,text,jsonb) to authenticated;
grant execute on function private.dnd_ai_search_retrieval(uuid,text,integer) to authenticated;

commit;
