begin;

create or replace function private.dnd_ai_public_session_intelligence(p_draft jsonb)
returns jsonb
language sql
immutable
set search_path = public, private, pg_temp
as $function$
  select case
    when p_draft is null or jsonb_typeof(p_draft) <> 'object' or p_draft = '{}'::jsonb then null
    else jsonb_build_object(
      'version', 1,
      'sessionTitle', case
        when jsonb_typeof(p_draft -> 'sessionTitle') = 'string' then p_draft ->> 'sessionTitle'
        else ''
      end,
      'playerRecap', case
        when jsonb_typeof(p_draft -> 'playerRecap') = 'string' then p_draft ->> 'playerRecap'
        else ''
      end,
      'canonFacts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'statement', case when jsonb_typeof(item.value -> 'statement') = 'string' then item.value ->> 'statement' else '' end,
          'confidence', case
            when item.value ->> 'confidence' in ('low','medium','high') then item.value ->> 'confidence'
            else 'medium'
          end
        ))
        from jsonb_array_elements(
          case when jsonb_typeof(p_draft -> 'canonFacts') = 'array'
            then p_draft -> 'canonFacts' else '[]'::jsonb end
        ) as item(value)
        where jsonb_typeof(item.value) = 'object'
          and item.value -> 'public' = 'true'::jsonb
      ), '[]'::jsonb),
      'unresolvedThreads', coalesce((
        select jsonb_agg(jsonb_build_object(
          'thread', case when jsonb_typeof(item.value -> 'thread') = 'string' then item.value ->> 'thread' else '' end,
          'status', case
            when item.value ->> 'status' in ('new','open','resolved') then item.value ->> 'status'
            else 'open'
          end
        ))
        from jsonb_array_elements(
          case when jsonb_typeof(p_draft -> 'unresolvedThreads') = 'array'
            then p_draft -> 'unresolvedThreads' else '[]'::jsonb end
        ) as item(value)
        where jsonb_typeof(item.value) = 'object'
          and item.value -> 'public' = 'true'::jsonb
      ), '[]'::jsonb)
    )
  end;
$function$;

create or replace function private.dnd_ai_save_session_intelligence(
  p_campaign_id uuid,
  p_session_id uuid,
  p_intelligence jsonb,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_session public.dnd_sessions%rowtype;
  v_tenant_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management permission is required' using errcode = '42501';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'A valid expected revision is required' using errcode = '22023';
  end if;
  if p_intelligence is null or jsonb_typeof(p_intelligence) <> 'object' then
    raise exception 'Session intelligence must be a JSON object' using errcode = '22023';
  end if;
  if not (p_intelligence ?& array[
    'version','sessionTitle','gmRecap','playerRecap','canonFacts','contradictions',
    'unresolvedThreads','entityChanges','nextSessionPrep'
  ]) then
    raise exception 'Session intelligence is missing required fields' using errcode = '22023';
  end if;
  if p_intelligence ->> 'version' <> '1'
    or jsonb_typeof(p_intelligence -> 'sessionTitle') <> 'string'
    or jsonb_typeof(p_intelligence -> 'gmRecap') <> 'string'
    or jsonb_typeof(p_intelligence -> 'playerRecap') <> 'string'
    or jsonb_typeof(p_intelligence -> 'canonFacts') <> 'array'
    or jsonb_typeof(p_intelligence -> 'contradictions') <> 'array'
    or jsonb_typeof(p_intelligence -> 'unresolvedThreads') <> 'array'
    or jsonb_typeof(p_intelligence -> 'entityChanges') <> 'array'
    or jsonb_typeof(p_intelligence -> 'nextSessionPrep') <> 'object'
  then
    raise exception 'Session intelligence field types are invalid' using errcode = '22023';
  end if;
  if length(p_intelligence ->> 'sessionTitle') > 300
    or length(p_intelligence ->> 'gmRecap') > 12000
    or length(p_intelligence ->> 'playerRecap') > 8000
    or jsonb_array_length(p_intelligence -> 'canonFacts') > 100
    or jsonb_array_length(p_intelligence -> 'contradictions') > 100
    or jsonb_array_length(p_intelligence -> 'unresolvedThreads') > 100
    or jsonb_array_length(p_intelligence -> 'entityChanges') > 100
    or octet_length(p_intelligence::text) > 160000
  then
    raise exception 'Session intelligence exceeds allowed limits' using errcode = '22023';
  end if;

  select * into v_session
  from public.dnd_sessions
  where id = p_session_id and campaign_id = p_campaign_id
  for update;

  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  if v_session.intelligence_revision <> p_expected_revision then
    raise exception 'Session intelligence changed; reload before saving'
      using errcode = '40001';
  end if;

  select tenant_id into v_tenant_id
  from public.dnd_campaigns
  where id = p_campaign_id;

  update public.dnd_sessions
  set intelligence_draft = p_intelligence,
      intelligence_revision = intelligence_revision + 1,
      intelligence_approved_by = null,
      intelligence_approved_at = null,
      intelligence_updated_at = now(),
      recap_draft = p_intelligence ->> 'playerRecap',
      recap_approved_by = null,
      recap_approved_at = null,
      updated_at = now()
  where id = p_session_id;

  insert into public.dnd_audit_log(
    tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.session_intelligence.saved',
    'session', p_session_id::text,
    jsonb_build_object('previousRevision', p_expected_revision, 'newRevision', p_expected_revision + 1)
  );

  return private.dnd_ai_session_intelligence(p_campaign_id, p_session_id);
end;
$function$;

commit;
