begin;

create or replace function private.dnd_ai_retrieval_sources(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  v_role := private.dnd_campaign_role(p_campaign_id);
  if v_role is null then
    raise exception 'Campaign not found or access denied' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'role', v_role,
    'canManage', v_role in ('admin','dm','assistant_dm'),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'ruleset', s.ruleset,
        'sourceVersion', s.source_version,
        'licenseType', s.license_type,
        'licenseReference', s.license_reference,
        'attributionText', s.attribution_text,
        'externalReferenceUrl', s.external_reference_url,
        'fullTextAllowed', s.is_full_text_allowed,
        'visibility', s.visibility,
        'enabled', cs.enabled,
        'entryCount', (
          select count(*)
          from public.dnd_content_entries e
          where e.source_id = s.id and e.active
        )
      ) order by s.name)
      from public.dnd_campaign_sources cs
      join public.dnd_sources s on s.id = cs.source_id
      where cs.campaign_id = p_campaign_id
        and cs.enabled
        and s.active
        and s.retrieval_enabled
        and (s.visibility = 'campaign_members' or v_role in ('admin','dm','assistant_dm'))
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function private.dnd_ai_upsert_retrieval_source(
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
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_tenant_id uuid;
  v_source public.dnd_sources%rowtype;
  v_full_text_allowed boolean;
  v_enabled boolean;
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

  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 240 then
    raise exception 'Source name is required and must be 240 characters or fewer' using errcode = '22023';
  end if;
  if p_license_type not in (
    'srd_cc_by','user_authored','user_supplied_private','metadata_only',
    'external_link','partner_api','unknown_restricted'
  ) then
    raise exception 'Unsupported license type' using errcode = '22023';
  end if;
  if p_visibility not in ('manager_only','campaign_members') then
    raise exception 'Unsupported source visibility' using errcode = '22023';
  end if;
  if length(coalesce(p_license_reference,'')) > 1000
    or length(coalesce(p_attribution_text,'')) > 2000
    or length(coalesce(p_external_reference_url,'')) > 2000
    or length(coalesce(p_ruleset,'')) > 120
    or length(coalesce(p_source_version,'')) > 120
  then
    raise exception 'Source metadata exceeds allowed limits' using errcode = '22023';
  end if;
  if p_license_type = 'srd_cc_by'
    and nullif(btrim(coalesce(p_attribution_text,'')), '') is null
  then
    raise exception 'Attribution is required for SRD CC BY sources' using errcode = '22023';
  end if;
  if p_license_type in ('external_link','partner_api')
    and nullif(btrim(coalesce(p_external_reference_url,'')), '') is null
  then
    raise exception 'An external reference URL is required for this source' using errcode = '22023';
  end if;
  if coalesce(p_full_text_allowed,false)
    and p_license_type in ('user_supplied_private','partner_api')
    and nullif(btrim(coalesce(p_license_reference,'')), '') is null
  then
    raise exception 'A rights or entitlement reference is required for this full-text source' using errcode = '22023';
  end if;

  v_enabled := coalesce(p_enabled, true);
  v_full_text_allowed := coalesce(p_full_text_allowed,false)
    and p_license_type in ('srd_cc_by','user_authored','user_supplied_private','partner_api');

  if p_source_id is null then
    insert into public.dnd_sources(
      tenant_id, name, ruleset, source_version, license_type, license_reference,
      attribution_text, external_reference_url, is_full_text_allowed, active,
      metadata, created_by, visibility, retrieval_enabled
    ) values (
      v_tenant_id, btrim(p_name), coalesce(p_ruleset,''), coalesce(p_source_version,''),
      p_license_type, coalesce(p_license_reference,''), coalesce(p_attribution_text,''),
      coalesce(p_external_reference_url,''), v_full_text_allowed, true,
      jsonb_build_object('createdForCampaign', p_campaign_id), auth.uid(), p_visibility, true
    ) returning * into v_source;
  else
    update public.dnd_sources
    set name = btrim(p_name),
        ruleset = coalesce(p_ruleset,''),
        source_version = coalesce(p_source_version,''),
        license_type = p_license_type,
        license_reference = coalesce(p_license_reference,''),
        attribution_text = coalesce(p_attribution_text,''),
        external_reference_url = coalesce(p_external_reference_url,''),
        is_full_text_allowed = v_full_text_allowed,
        visibility = p_visibility,
        retrieval_enabled = true,
        updated_at = now()
    where id = p_source_id and tenant_id = v_tenant_id
    returning * into v_source;

    if not found then
      raise exception 'Source not found or not editable for this tenant' using errcode = 'P0002';
    end if;
  end if;

  insert into public.dnd_campaign_sources(campaign_id, source_id, enabled, created_by)
  values (p_campaign_id, v_source.id, v_enabled, auth.uid())
  on conflict (campaign_id, source_id)
  do update set enabled = excluded.enabled, updated_at = now();

  insert into public.dnd_audit_log(
    tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.retrieval.source_upserted',
    'source', v_source.id::text,
    jsonb_build_object(
      'licenseType', v_source.license_type,
      'fullTextAllowed', v_source.is_full_text_allowed,
      'visibility', v_source.visibility,
      'enabled', v_enabled
    )
  );

  return jsonb_build_object(
    'id', v_source.id,
    'name', v_source.name,
    'ruleset', v_source.ruleset,
    'sourceVersion', v_source.source_version,
    'licenseType', v_source.license_type,
    'licenseReference', v_source.license_reference,
    'attributionText', v_source.attribution_text,
    'externalReferenceUrl', v_source.external_reference_url,
    'fullTextAllowed', v_source.is_full_text_allowed,
    'visibility', v_source.visibility,
    'enabled', v_enabled
  );
end;
$function$;

commit;
