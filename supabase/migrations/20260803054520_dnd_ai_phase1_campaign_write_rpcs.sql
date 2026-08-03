-- Transactional, audited campaign writes. These functions run with elevated
-- database privileges but explicitly authorize the caller through auth.uid().

begin;

create or replace function private.dnd_ai_create_campaign(
  p_tenant_id uuid,
  p_name text,
  p_description text,
  p_ruleset text,
  p_current_location text,
  p_ai_state jsonb,
  p_characters jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private, extensions, pg_temp
as $function$
declare
  v_campaign_id uuid;
  v_character jsonb;
  v_tenant_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  v_tenant_role := private.nexus_tenant_role(p_tenant_id);
  if v_tenant_role not in ('owner', 'admin', 'member') then
    raise exception 'Tenant access denied' using errcode = '42501';
  end if;
  if nullif(btrim(p_name), '') is null then
    raise exception 'Campaign name is required' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_characters, '[]'::jsonb)) <> 'array' then
    raise exception 'p_characters must be a JSON array' using errcode = '22023';
  end if;

  insert into public.dnd_campaigns (
    tenant_id, name, description, status, ruleset, owner_user_id,
    current_location, metadata
  ) values (
    p_tenant_id, btrim(p_name), coalesce(p_description, ''), 'planning',
    coalesce(nullif(btrim(p_ruleset), ''), '5e_2024'), auth.uid(),
    coalesce(p_current_location, ''),
    jsonb_build_object('ai', coalesce(p_ai_state, '{}'::jsonb))
  ) returning id into v_campaign_id;

  for v_character in
    select value from jsonb_array_elements(coalesce(p_characters, '[]'::jsonb))
  loop
    if nullif(btrim(v_character ->> 'name'), '') is not null then
      insert into public.dnd_characters (
        campaign_id, owner_user_id, name, class_name, metadata
      ) values (
        v_campaign_id,
        auth.uid(),
        btrim(v_character ->> 'name'),
        '',
        jsonb_build_object(
          'playerName', coalesce(v_character ->> 'playerName', ''),
          'summary', coalesce(v_character ->> 'summary', '')
        )
      );
    end if;
  end loop;

  insert into public.dnd_audit_log (
    tenant_id, campaign_id, actor_user_id, action, outcome,
    target_type, target_id, metadata
  ) values (
    p_tenant_id, v_campaign_id, auth.uid(), 'ai.campaign.create', 'success',
    'campaign', v_campaign_id::text, jsonb_build_object('source', 'khaos-nexus-ai')
  );

  return private.dnd_ai_campaign_workspace(v_campaign_id);
end;
$function$;

create or replace function public.dnd_ai_create_campaign(
  p_tenant_id uuid,
  p_name text,
  p_description text,
  p_ruleset text,
  p_current_location text,
  p_ai_state jsonb,
  p_characters jsonb
)
returns jsonb
language sql
volatile
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_create_campaign(
    p_tenant_id, p_name, p_description, p_ruleset,
    p_current_location, p_ai_state, p_characters
  );
$function$;

create or replace function private.dnd_ai_update_campaign_state(
  p_campaign_id uuid,
  p_expected_updated_at timestamptz,
  p_current_location text,
  p_ai_state jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_tenant_id uuid;
begin
  if auth.uid() is null or not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management access denied' using errcode = '42501';
  end if;

  update public.dnd_campaigns c
  set current_location = coalesce(p_current_location, ''),
      metadata = jsonb_set(coalesce(c.metadata, '{}'::jsonb), '{ai}', coalesce(p_ai_state, '{}'::jsonb), true),
      updated_at = now()
  where c.id = p_campaign_id
    and c.updated_at = p_expected_updated_at
  returning c.tenant_id into v_tenant_id;

  if v_tenant_id is null then
    raise exception 'Campaign changed since it was loaded; reload and retry' using errcode = '40001';
  end if;

  insert into public.dnd_audit_log (
    tenant_id, campaign_id, actor_user_id, action, outcome,
    target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.campaign.state.update', 'success',
    'campaign', p_campaign_id::text, jsonb_build_object('source', 'khaos-nexus-ai')
  );

  return private.dnd_ai_campaign_workspace(p_campaign_id);
end;
$function$;

create or replace function public.dnd_ai_update_campaign_state(
  p_campaign_id uuid,
  p_expected_updated_at timestamptz,
  p_current_location text,
  p_ai_state jsonb
)
returns jsonb
language sql
volatile
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_update_campaign_state(
    p_campaign_id, p_expected_updated_at, p_current_location, p_ai_state
  );
$function$;

revoke all on function private.dnd_ai_create_campaign(uuid,text,text,text,text,jsonb,jsonb) from public, anon;
revoke all on function private.dnd_ai_update_campaign_state(uuid,timestamptz,text,jsonb) from public, anon;
grant execute on function private.dnd_ai_create_campaign(uuid,text,text,text,text,jsonb,jsonb) to authenticated;
grant execute on function private.dnd_ai_update_campaign_state(uuid,timestamptz,text,jsonb) to authenticated;
revoke all on function public.dnd_ai_create_campaign(uuid,text,text,text,text,jsonb,jsonb) from public, anon;
revoke all on function public.dnd_ai_update_campaign_state(uuid,timestamptz,text,jsonb) from public, anon;
grant execute on function public.dnd_ai_create_campaign(uuid,text,text,text,text,jsonb,jsonb) to authenticated;
grant execute on function public.dnd_ai_update_campaign_state(uuid,timestamptz,text,jsonb) to authenticated;

commit;
