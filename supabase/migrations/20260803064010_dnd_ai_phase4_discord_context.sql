-- Phase 4B: resolve a Discord command only when the authenticated account,
-- Discord actor, registered app, guild, and existing bound resource all match.
begin;

create or replace function private.dnd_ai_discord_context(
  p_registered_app_id uuid,
  p_guild_id text,
  p_resource_id text,
  p_discord_user_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_binding public.dnd_discord_bindings%rowtype;
  v_member public.dnd_campaign_members%rowtype;
  v_campaign public.dnd_campaigns%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select b.* into v_binding
  from public.dnd_discord_bindings b
  join public.discord_registered_apps a
    on a.id = b.registered_app_id
   and a.enabled
  where b.registered_app_id = p_registered_app_id
    and b.guild_id = p_guild_id
    and b.resource_id = p_resource_id
    and b.active
    and b.verified_at is not null
  order by b.is_primary desc, (b.purpose = 'main') desc, b.updated_at desc
  limit 1;

  if v_binding.id is null then
    raise exception 'No active verified campaign binding for this Discord resource' using errcode = 'P0002';
  end if;

  select * into v_member
  from public.dnd_campaign_members m
  where m.campaign_id = v_binding.campaign_id
    and m.user_id = auth.uid()
    and m.discord_user_id = p_discord_user_id
    and m.active
  limit 1;

  if v_member.id is null then
    raise exception 'Discord actor is not linked to the authenticated campaign member' using errcode = '42501';
  end if;

  select * into v_campaign
  from public.dnd_campaigns c
  where c.id = v_binding.campaign_id;

  return jsonb_build_object(
    'campaignId', v_binding.campaign_id,
    'tenantId', v_campaign.tenant_id,
    'binding', jsonb_build_object(
      'id', v_binding.id,
      'registeredAppId', v_binding.registered_app_id,
      'guildId', v_binding.guild_id,
      'resourceType', v_binding.resource_type,
      'resourceId', v_binding.resource_id,
      'purpose', v_binding.purpose,
      'isPrimary', v_binding.is_primary
    ),
    'member', jsonb_build_object(
      'id', v_member.id,
      'userId', v_member.user_id,
      'discordUserId', v_member.discord_user_id,
      'displayName', v_member.display_name,
      'role', v_member.role,
      'capabilities', v_member.capabilities
    ),
    'canManage', v_member.role in ('dm', 'assistant_dm')
      or 'campaign_manage' = any(v_member.capabilities)
      or private.dnd_can_manage_campaign(v_binding.campaign_id)
  );
end;
$function$;

create or replace function public.dnd_ai_discord_context(
  p_registered_app_id uuid,
  p_guild_id text,
  p_resource_id text,
  p_discord_user_id text
)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_discord_context(
    p_registered_app_id, p_guild_id, p_resource_id, p_discord_user_id
  );
$function$;

revoke all on function private.dnd_ai_discord_context(uuid,text,text,text) from public, anon;
grant execute on function private.dnd_ai_discord_context(uuid,text,text,text) to authenticated;
revoke all on function public.dnd_ai_discord_context(uuid,text,text,text) from public, anon;
grant execute on function public.dnd_ai_discord_context(uuid,text,text,text) to authenticated;

commit;
