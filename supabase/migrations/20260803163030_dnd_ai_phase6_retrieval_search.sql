begin;

create or replace function private.dnd_ai_search_retrieval(
  p_campaign_id uuid,
  p_query text,
  p_limit integer default 8
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_role text;
  v_can_manage boolean;
  v_limit integer;
  v_query text;
  v_results jsonb;
  v_tenant_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  v_role := private.dnd_campaign_role(p_campaign_id);
  if v_role is null then
    raise exception 'Campaign not found or access denied' using errcode = '42501';
  end if;

  v_can_manage := v_role in ('admin','dm','assistant_dm');
  v_query := btrim(coalesce(p_query,''));
  if length(v_query) < 3 or length(v_query) > 500 then
    raise exception 'Search query must be between 3 and 500 characters' using errcode = '22023';
  end if;
  if lower(v_query) ~ '(verbatim|exact[ -]?copy|full[ -]?text|entire[ ]+(book|chapter|module|adventure|source)|whole[ ]+(book|chapter|module|adventure|source)|reproduce|reconstruct|page[s]?[ ]+[0-9]+[ ]*(-|through|to)[ ]*[0-9]+|continue[ ]+from[ ]+(the[ ]+)?previous)' then
    raise exception 'Retrieval cannot be used to reconstruct or export source text' using errcode = '22023';
  end if;

  v_limit := greatest(1, least(coalesce(p_limit,8), 10));
  select tenant_id into v_tenant_id
  from public.dnd_campaigns
  where id = p_campaign_id;

  with q as (
    select websearch_to_tsquery('pg_catalog.english'::regconfig, v_query) as value
  ),
  source_results as (
    select
      'source_entry'::text as result_kind,
      'source:' || s.id::text || ':entry:' || e.id::text as citation_id,
      s.id as source_id,
      e.id as entry_id,
      e.name,
      left(case
        when s.is_full_text_allowed and e.full_text is not null then e.full_text
        else e.summary
      end, 700) as excerpt,
      s.name as source_name,
      s.license_type,
      s.attribution_text,
      s.external_reference_url,
      e.content_origin,
      ts_rank_cd(e.search_vector, q.value) as rank
    from q
    join public.dnd_campaign_sources cs
      on cs.campaign_id = p_campaign_id
     and cs.enabled
    join public.dnd_sources s
      on s.id = cs.source_id
     and s.active
     and s.retrieval_enabled
    join public.dnd_content_entries e
      on e.source_id = s.id
     and e.active
    where e.search_vector @@ q.value
      and (s.tenant_id is null or s.tenant_id = v_tenant_id)
      and (v_can_manage or s.visibility = 'campaign_members')
      and (
        v_can_manage
        or e.visibility = 'campaign_members'
        or (e.visibility = 'inherit' and s.visibility = 'campaign_members')
      )
  ),
  homebrew_results as (
    select
      'homebrew'::text as result_kind,
      'homebrew:' || h.id::text || ':revision:' || h.revision::text as citation_id,
      null::uuid as source_id,
      h.id as entry_id,
      h.name,
      left(coalesce(h.body ->> 'summary', h.name), 700) as excerpt,
      'Campaign homebrew'::text as source_name,
      'user_authored'::text as license_type,
      ''::text as attribution_text,
      ''::text as external_reference_url,
      'campaign_generated'::text as content_origin,
      ts_rank_cd(
        to_tsvector('pg_catalog.english'::regconfig, h.name || ' ' || coalesce(h.body::text,'')),
        q.value
      ) as rank
    from q
    join public.dnd_homebrew h
      on h.campaign_id = p_campaign_id
    where (h.status = 'approved' or v_can_manage)
      and to_tsvector(
        'pg_catalog.english'::regconfig,
        h.name || ' ' || coalesce(h.body::text,'')
      ) @@ q.value
  ),
  session_results as (
    select
      'session_recap'::text as result_kind,
      'session:' || s.id::text || ':intelligence:' || s.intelligence_revision::text as citation_id,
      null::uuid as source_id,
      s.id as entry_id,
      s.title as name,
      left(case
        when v_can_manage then coalesce(s.intelligence_draft ->> 'gmRecap', s.recap_draft)
        else coalesce(s.intelligence_draft ->> 'playerRecap', s.recap_draft)
      end, 700) as excerpt,
      'Campaign session'::text as source_name,
      'user_authored'::text as license_type,
      ''::text as attribution_text,
      ''::text as external_reference_url,
      'campaign_generated'::text as content_origin,
      ts_rank_cd(
        to_tsvector(
          'pg_catalog.english'::regconfig,
          s.title || ' ' || case
            when v_can_manage then coalesce(s.intelligence_draft ->> 'gmRecap', s.recap_draft)
            else coalesce(s.intelligence_draft ->> 'playerRecap', s.recap_draft)
          end
        ),
        q.value
      ) as rank
    from q
    join public.dnd_sessions s
      on s.campaign_id = p_campaign_id
    where s.intelligence_revision > 0
      and (v_can_manage or s.intelligence_approved_at is not null)
      and to_tsvector(
        'pg_catalog.english'::regconfig,
        s.title || ' ' || case
          when v_can_manage then coalesce(s.intelligence_draft ->> 'gmRecap', s.recap_draft)
          else coalesce(s.intelligence_draft ->> 'playerRecap', s.recap_draft)
        end
      ) @@ q.value
  ),
  combined as (
    select * from source_results
    union all
    select * from homebrew_results
    union all
    select * from session_results
  ),
  limited as (
    select *
    from combined
    order by rank desc, name
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', result_kind,
    'citationId', citation_id,
    'sourceId', source_id,
    'entryId', entry_id,
    'name', name,
    'excerpt', excerpt,
    'sourceName', source_name,
    'licenseType', license_type,
    'attributionText', attribution_text,
    'externalReferenceUrl', external_reference_url,
    'contentOrigin', content_origin,
    'rank', rank
  ) order by rank desc, name), '[]'::jsonb)
  into v_results
  from limited;

  insert into public.dnd_audit_log(
    tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.retrieval.searched',
    'campaign', p_campaign_id::text,
    jsonb_build_object(
      'queryHash', md5(v_query),
      'resultCount', jsonb_array_length(v_results),
      'limit', v_limit
    )
  );

  return jsonb_build_object(
    'role', v_role,
    'canManage', v_can_manage,
    'query', v_query,
    'results', v_results,
    'excerptLimit', 700,
    'resultLimit', v_limit
  );
end;
$function$;

commit;
