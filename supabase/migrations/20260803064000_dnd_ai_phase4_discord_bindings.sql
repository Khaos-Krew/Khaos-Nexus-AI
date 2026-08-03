-- Phase 4A: bind campaigns to existing Discord resources only.
begin;

create or replace function private.dnd_ai_discord_bindings(p_campaign_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $function$
  select case
    when auth.uid() is null or not private.dnd_can_manage_campaign(p_campaign_id)
      then null
    else jsonb_build_object(
      'bindings',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', b.id,
          'campaignId', b.campaign_id,
          'registeredAppId', b.registered_app_id,
          'guildId', b.guild_id,
          'resourceType', b.resource_type,
          'resourceId', b.resource_id,
          'parentChannelId', b.parent_channel_id,
          'displayName', b.display_name,
          'purpose', b.purpose,
          'isPrimary', b.is_primary,
          'active', b.active,
          'verifiedAt', b.verified_at,
          'lastErrorCode', b.last_error_code,
          'createdAt', b.created_at,
          'updatedAt', b.updated_at
        ) order by b.is_primary desc, b.purpose, b.created_at)
        from public.dnd_discord_bindings b
        where b.campaign_id = p_campaign_id
      ), '[]'::jsonb)
    )
  end;
$function$;

create or replace function public.dnd_ai_discord_bindings(p_campaign_id uuid)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_discord_bindings(p_campaign_id);
$function$;

create or replace function private.dnd_ai_upsert_discord_binding(
  p_campaign_id uuid,
  p_binding_id uuid,
  p_registered_app_id uuid,
  p_guild_id text,
  p_resource_type text,
  p_resource_id text,
  p_parent_channel_id text,
  p_display_name text,
  p_purpose text,
  p_is_primary boolean,
  p_active boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_campaign_tenant uuid;
  v_app_tenant uuid;
  v_app_enabled boolean;
  v_binding public.dnd_discord_bindings%rowtype;
  v_binding_id uuid;
begin
  if auth.uid() is null or not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management access denied' using errcode = '42501';
  end if;
  if not private.dnd_user_can_manage_app(p_registered_app_id) then
    raise exception 'Discord app management access denied' using errcode = '42501';
  end if;

  select tenant_id into v_campaign_tenant from public.dnd_campaigns where id = p_campaign_id;
  select tenant_id, enabled into v_app_tenant, v_app_enabled
  from public.discord_registered_apps where id = p_registered_app_id;

  if v_campaign_tenant is null or v_app_tenant is null then
    raise exception 'Campaign or Discord app not found' using errcode = 'P0002';
  end if;
  if v_campaign_tenant <> v_app_tenant then
    raise exception 'Discord app and campaign must belong to the same tenant' using errcode = '42501';
  end if;
  if not v_app_enabled then
    raise exception 'Discord app is disabled' using errcode = '22023';
  end if;
  if p_purpose = 'voice' then
    raise exception 'Voice bindings are deferred and cannot be created' using errcode = '22023';
  end if;

  v_binding_id := p_binding_id;
  if v_binding_id is null then
    select b.id into v_binding_id
    from public.dnd_discord_bindings b
    where b.campaign_id = p_campaign_id
      and b.registered_app_id = p_registered_app_id
      and b.guild_id = p_guild_id
      and b.resource_type = p_resource_type
      and b.resource_id = p_resource_id
      and b.purpose = p_purpose
    order by b.active desc, b.updated_at desc
    limit 1;
  end if;

  if coalesce(p_is_primary, false) and p_purpose = 'main' then
    update public.dnd_discord_bindings b
    set is_primary = false, updated_at = now()
    where b.campaign_id = p_campaign_id
      and b.registered_app_id = p_registered_app_id
      and b.guild_id = p_guild_id
      and b.purpose = 'main'
      and b.active
      and (v_binding_id is null or b.id <> v_binding_id);
  end if;

  if v_binding_id is null then
    insert into public.dnd_discord_bindings (
      campaign_id, registered_app_id, guild_id, resource_type, resource_id,
      parent_channel_id, display_name, purpose, is_primary, active, creator_id,
      metadata, verified_at, last_error_code
    ) values (
      p_campaign_id, p_registered_app_id, p_guild_id, p_resource_type, p_resource_id,
      nullif(p_parent_channel_id, ''), coalesce(p_display_name, ''), p_purpose,
      coalesce(p_is_primary, false), coalesce(p_active, true), auth.uid(),
      jsonb_build_object('source', 'khaos-nexus-ai'), null, ''
    ) returning * into v_binding;
  else
    update public.dnd_discord_bindings b
    set guild_id = p_guild_id,
        resource_type = p_resource_type,
        resource_id = p_resource_id,
        parent_channel_id = nullif(p_parent_channel_id, ''),
        display_name = coalesce(p_display_name, ''),
        purpose = p_purpose,
        is_primary = coalesce(p_is_primary, false),
        active = coalesce(p_active, true),
        verified_at = null,
        last_error_code = '',
        updated_at = now()
    where b.id = v_binding_id
      and b.campaign_id = p_campaign_id
      and b.registered_app_id = p_registered_app_id
    returning * into v_binding;
  end if;

  if v_binding.id is null then
    raise exception 'Discord binding not found or app mismatch' using errcode = 'P0002';
  end if;

  insert into public.dnd_audit_log (
    tenant_id, campaign_id, actor_user_id, action, outcome,
    target_type, target_id, metadata
  ) values (
    v_campaign_tenant, p_campaign_id, auth.uid(), 'ai.discord.binding.upsert', 'success',
    'discord_binding', v_binding.id::text,
    jsonb_build_object('guildId', p_guild_id, 'resourceId', p_resource_id, 'purpose', p_purpose)
  );

  return to_jsonb(v_binding);
end;
$function$;

create or replace function public.dnd_ai_upsert_discord_binding(
  p_campaign_id uuid,
  p_binding_id uuid,
  p_registered_app_id uuid,
  p_guild_id text,
  p_resource_type text,
  p_resource_id text,
  p_parent_channel_id text,
  p_display_name text,
  p_purpose text,
  p_is_primary boolean,
  p_active boolean
)
returns jsonb
language sql
volatile
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_upsert_discord_binding(
    p_campaign_id, p_binding_id, p_registered_app_id, p_guild_id,
    p_resource_type, p_resource_id, p_parent_channel_id, p_display_name,
    p_purpose, p_is_primary, p_active
  );
$function$;

create or replace function private.dnd_ai_verify_discord_binding(
  p_campaign_id uuid,
  p_binding_id uuid,
  p_verified boolean,
  p_error_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_binding public.dnd_discord_bindings%rowtype;
  v_tenant_id uuid;
begin
  if auth.uid() is null or not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management access denied' using errcode = '42501';
  end if;

  select * into v_binding
  from public.dnd_discord_bindings b
  where b.id = p_binding_id and b.campaign_id = p_campaign_id
  for update;
  if v_binding.id is null then
    raise exception 'Discord binding not found' using errcode = 'P0002';
  end if;
  if not private.dnd_user_can_manage_app(v_binding.registered_app_id) then
    raise exception 'Discord app management access denied' using errcode = '42501';
  end if;

  update public.dnd_discord_bindings b
  set verified_at = case when p_verified then now() else null end,
      last_error_code = case when p_verified then '' else left(coalesce(p_error_code, 'verification_failed'), 120) end,
      updated_at = now()
  where b.id = p_binding_id
  returning * into v_binding;

  select tenant_id into v_tenant_id from public.dnd_campaigns where id = p_campaign_id;
  insert into public.dnd_audit_log (
    tenant_id, campaign_id, actor_user_id, action, outcome,
    target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.discord.binding.verify',
    case when p_verified then 'success' else 'failure' end,
    'discord_binding', v_binding.id::text,
    jsonb_build_object('errorCode', v_binding.last_error_code)
  );

  return to_jsonb(v_binding);
end;
$function$;

create or replace function public.dnd_ai_verify_discord_binding(
  p_campaign_id uuid,
  p_binding_id uuid,
  p_verified boolean,
  p_error_code text
)
returns jsonb
language sql
volatile
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_verify_discord_binding(p_campaign_id, p_binding_id, p_verified, p_error_code);
$function$;

revoke all on function private.dnd_ai_discord_bindings(uuid) from public, anon;
revoke all on function private.dnd_ai_upsert_discord_binding(uuid,uuid,uuid,text,text,text,text,text,text,boolean,boolean) from public, anon;
revoke all on function private.dnd_ai_verify_discord_binding(uuid,uuid,boolean,text) from public, anon;
grant execute on function private.dnd_ai_discord_bindings(uuid) to authenticated;
grant execute on function private.dnd_ai_upsert_discord_binding(uuid,uuid,uuid,text,text,text,text,text,text,boolean,boolean) to authenticated;
grant execute on function private.dnd_ai_verify_discord_binding(uuid,uuid,boolean,text) to authenticated;
revoke all on function public.dnd_ai_discord_bindings(uuid) from public, anon;
revoke all on function public.dnd_ai_upsert_discord_binding(uuid,uuid,uuid,text,text,text,text,text,text,boolean,boolean) from public, anon;
revoke all on function public.dnd_ai_verify_discord_binding(uuid,uuid,boolean,text) from public, anon;
grant execute on function public.dnd_ai_discord_bindings(uuid) to authenticated;
grant execute on function public.dnd_ai_upsert_discord_binding(uuid,uuid,uuid,text,text,text,text,text,text,boolean,boolean) to authenticated;
grant execute on function public.dnd_ai_verify_discord_binding(uuid,uuid,boolean,text) to authenticated;

commit;
