-- Unauthorized callers receive a permission error instead of an ambiguous empty list.
begin;

create or replace function private.dnd_ai_discord_bindings(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null or not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management access denied' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'bindings',
    coalesce(jsonb_agg(jsonb_build_object(
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
    ) order by b.is_primary desc, b.purpose, b.created_at), '[]'::jsonb)
  ) into v_result
  from public.dnd_discord_bindings b
  where b.campaign_id = p_campaign_id;

  return v_result;
end;
$function$;

commit;
