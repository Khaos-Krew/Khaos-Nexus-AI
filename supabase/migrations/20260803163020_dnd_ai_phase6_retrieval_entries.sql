begin;

create or replace function private.dnd_ai_upsert_retrieval_entry(
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
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_source public.dnd_sources%rowtype;
  v_entry public.dnd_content_entries%rowtype;
  v_hash text;
  v_tenant_id uuid;
  v_existing_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management permission is required' using errcode = '42501';
  end if;

  select tenant_id into v_tenant_id
  from public.dnd_campaigns
  where id = p_campaign_id;

  if v_tenant_id is null then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;

  select s.* into v_source
  from public.dnd_campaign_sources cs
  join public.dnd_sources s
    on s.id = cs.source_id
   and s.active
   and s.retrieval_enabled
  where cs.campaign_id = p_campaign_id
    and cs.source_id = p_source_id
    and cs.enabled
  for update of s;

  if not found then
    raise exception 'Enabled retrieval source not found for campaign' using errcode = 'P0002';
  end if;
  if v_source.tenant_id is null then
    raise exception 'Global sources cannot be edited through the campaign API' using errcode = '42501';
  end if;
  if v_source.tenant_id <> v_tenant_id then
    raise exception 'Source and campaign tenants do not match' using errcode = '42501';
  end if;
  if nullif(btrim(p_name),'') is null or length(btrim(p_name)) > 300 then
    raise exception 'Entry name is required and must be 300 characters or fewer' using errcode = '22023';
  end if;
  if nullif(btrim(p_content_type),'') is null or length(btrim(p_content_type)) > 100 then
    raise exception 'Content type is required and must be 100 characters or fewer' using errcode = '22023';
  end if;
  if length(coalesce(p_summary,'')) > 4000 or length(coalesce(p_full_text,'')) > 50000 then
    raise exception 'Content exceeds allowed per-entry limits' using errcode = '22023';
  end if;
  if p_content_origin not in (
    'metadata_only','user_authored','licensed_full_text','licensed_summary',
    'public_domain','partner_api','external_reference','campaign_generated'
  ) then
    raise exception 'Unsupported content origin' using errcode = '22023';
  end if;
  if p_visibility not in ('inherit','manager_only','campaign_members') then
    raise exception 'Unsupported entry visibility' using errcode = '22023';
  end if;
  if p_metadata is null
    or jsonb_typeof(p_metadata) <> 'object'
    or octet_length(p_metadata::text) > 12000
  then
    raise exception 'Entry metadata must be a limited JSON object' using errcode = '22023';
  end if;
  if p_content_origin = 'metadata_only' and nullif(coalesce(p_full_text,''),'') is not null then
    raise exception 'Metadata-only entries cannot contain full text' using errcode = '22023';
  end if;
  if p_content_origin = 'partner_api' and v_source.license_type <> 'partner_api' then
    raise exception 'Partner API content requires a partner API source' using errcode = '22023';
  end if;
  if p_content_origin = 'external_reference' and v_source.license_type <> 'external_link' then
    raise exception 'External reference content requires an external-link source' using errcode = '22023';
  end if;
  if nullif(coalesce(p_full_text,''),'') is not null and not v_source.is_full_text_allowed then
    raise exception 'Full text is not allowed for this source' using errcode = '22023';
  end if;
  if v_source.license_type in ('metadata_only','external_link','unknown_restricted')
    and nullif(coalesce(p_full_text,''),'') is not null
  then
    raise exception 'Restricted sources may store summaries and metadata only' using errcode = '22023';
  end if;
  if p_content_origin = 'licensed_full_text' and not v_source.is_full_text_allowed then
    raise exception 'Licensed full text requires an authorized full-text source' using errcode = '22023';
  end if;

  v_hash := md5(
    lower(btrim(p_content_type)) || E'\n' || lower(btrim(p_name)) || E'\n' ||
    coalesce(p_summary,'') || E'\n' || coalesce(p_full_text,'')
  );

  if p_entry_id is null then
    select id into v_existing_id
    from public.dnd_content_entries
    where source_id = p_source_id
      and content_hash = v_hash
      and active
    limit 1;
  else
    v_existing_id := p_entry_id;
  end if;

  if v_existing_id is null then
    insert into public.dnd_content_entries(
      source_id, content_type, name, summary, full_text, content_origin,
      content_hash, active, metadata, visibility
    ) values (
      p_source_id, btrim(p_content_type), btrim(p_name), coalesce(p_summary,''),
      nullif(p_full_text,''), p_content_origin, v_hash, true, p_metadata, p_visibility
    ) returning * into v_entry;
  else
    update public.dnd_content_entries
    set content_type = btrim(p_content_type),
        name = btrim(p_name),
        summary = coalesce(p_summary,''),
        full_text = nullif(p_full_text,''),
        content_origin = p_content_origin,
        content_hash = v_hash,
        active = true,
        metadata = p_metadata,
        visibility = p_visibility,
        updated_at = now()
    where id = v_existing_id
      and source_id = p_source_id
    returning * into v_entry;

    if not found then
      raise exception 'Content entry not found for source' using errcode = 'P0002';
    end if;
  end if;

  insert into public.dnd_audit_log(
    tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.retrieval.entry_upserted',
    'content_entry', v_entry.id::text,
    jsonb_build_object(
      'sourceId', p_source_id,
      'contentOrigin', v_entry.content_origin,
      'contentHash', v_entry.content_hash,
      'hasFullText', v_entry.full_text is not null,
      'visibility', v_entry.visibility
    )
  );

  return jsonb_build_object(
    'id', v_entry.id,
    'sourceId', v_entry.source_id,
    'contentType', v_entry.content_type,
    'name', v_entry.name,
    'summary', v_entry.summary,
    'contentOrigin', v_entry.content_origin,
    'contentHash', v_entry.content_hash,
    'hasFullText', v_entry.full_text is not null,
    'visibility', v_entry.visibility
  );
end;
$function$;

commit;
