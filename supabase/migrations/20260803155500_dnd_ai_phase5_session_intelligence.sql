begin;

alter table public.dnd_sessions
  add column if not exists intelligence_draft jsonb not null default '{}'::jsonb,
  add column if not exists intelligence_revision integer not null default 0,
  add column if not exists intelligence_approved_by uuid references auth.users(id) on delete set null,
  add column if not exists intelligence_approved_at timestamptz,
  add column if not exists intelligence_updated_at timestamptz;

alter table public.dnd_sessions
  drop constraint if exists dnd_sessions_intelligence_revision_check;

alter table public.dnd_sessions
  add constraint dnd_sessions_intelligence_revision_check
  check (intelligence_revision >= 0);

create index if not exists dnd_sessions_intelligence_updated_idx
  on public.dnd_sessions (campaign_id, intelligence_updated_at desc)
  where intelligence_revision > 0;

create or replace function private.dnd_ai_public_session_intelligence(p_draft jsonb)
returns jsonb
language sql
immutable
set search_path = public, private, pg_temp
as $function$
  select case
    when p_draft is null or jsonb_typeof(p_draft) <> 'object' or p_draft = '{}'::jsonb then null
    else jsonb_build_object(
      'version', coalesce(p_draft -> 'version', '1'::jsonb),
      'sessionTitle', coalesce(p_draft -> 'sessionTitle', '""'::jsonb),
      'playerRecap', coalesce(p_draft -> 'playerRecap', '""'::jsonb),
      'canonFacts', coalesce((
        select jsonb_agg(item.value)
        from jsonb_array_elements(coalesce(p_draft -> 'canonFacts', '[]'::jsonb)) as item(value)
        where coalesce((item.value ->> 'public')::boolean, false)
      ), '[]'::jsonb),
      'unresolvedThreads', coalesce((
        select jsonb_agg(item.value)
        from jsonb_array_elements(coalesce(p_draft -> 'unresolvedThreads', '[]'::jsonb)) as item(value)
        where coalesce((item.value ->> 'public')::boolean, false)
      ), '[]'::jsonb)
    )
  end;
$function$;

create or replace function private.dnd_ai_session_intelligence(
  p_campaign_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_role text;
  v_can_manage boolean;
  v_session public.dnd_sessions%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  v_role := private.dnd_campaign_role(p_campaign_id);
  if v_role is null then
    raise exception 'Campaign not found or access denied' using errcode = '42501';
  end if;
  v_can_manage := v_role in ('admin', 'dm', 'assistant_dm');

  select * into v_session
  from public.dnd_sessions
  where id = p_session_id and campaign_id = p_campaign_id;

  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'role', v_role,
    'canManage', v_can_manage,
    'session', jsonb_build_object(
      'id', v_session.id,
      'campaign_id', v_session.campaign_id,
      'title', v_session.title,
      'status', v_session.status,
      'starts_at', v_session.starts_at,
      'ends_at', v_session.ends_at,
      'timezone', v_session.timezone,
      'agenda', v_session.agenda,
      'dm_notes', case when v_can_manage then v_session.dm_notes else '' end,
      'updated_at', v_session.updated_at
    ),
    'intelligence', case
      when v_can_manage then nullif(v_session.intelligence_draft, '{}'::jsonb)
      when v_session.intelligence_approved_at is not null
        then private.dnd_ai_public_session_intelligence(v_session.intelligence_draft)
      else null
    end,
    'revision', v_session.intelligence_revision,
    'approved', v_session.intelligence_approved_at is not null,
    'approved_at', v_session.intelligence_approved_at,
    'updated_at', v_session.intelligence_updated_at
  );
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
  if octet_length(p_intelligence::text) > 160000 then
    raise exception 'Session intelligence is too large' using errcode = '22023';
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
      recap_draft = coalesce(p_intelligence ->> 'playerRecap', ''),
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

create or replace function private.dnd_ai_approve_session_intelligence(
  p_campaign_id uuid,
  p_session_id uuid,
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

  select * into v_session
  from public.dnd_sessions
  where id = p_session_id and campaign_id = p_campaign_id
  for update;

  if not found then
    raise exception 'Session not found' using errcode = 'P0002';
  end if;
  if v_session.intelligence_revision = 0 or v_session.intelligence_draft = '{}'::jsonb then
    raise exception 'No session intelligence draft exists' using errcode = '22023';
  end if;
  if v_session.intelligence_revision <> p_expected_revision then
    raise exception 'Session intelligence changed; reload before approving'
      using errcode = '40001';
  end if;

  select tenant_id into v_tenant_id
  from public.dnd_campaigns
  where id = p_campaign_id;

  update public.dnd_sessions
  set intelligence_approved_by = auth.uid(),
      intelligence_approved_at = now(),
      recap_approved_by = auth.uid(),
      recap_approved_at = now(),
      updated_at = now()
  where id = p_session_id;

  insert into public.dnd_audit_log(
    tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.session_intelligence.approved',
    'session', p_session_id::text,
    jsonb_build_object('revision', p_expected_revision)
  );

  return private.dnd_ai_session_intelligence(p_campaign_id, p_session_id);
end;
$function$;

create or replace function public.dnd_ai_session_intelligence(
  p_campaign_id uuid,
  p_session_id uuid
)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_session_intelligence(p_campaign_id, p_session_id);
$function$;

create or replace function public.dnd_ai_save_session_intelligence(
  p_campaign_id uuid,
  p_session_id uuid,
  p_intelligence jsonb,
  p_expected_revision integer
)
returns jsonb
language sql
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_save_session_intelligence(
    p_campaign_id, p_session_id, p_intelligence, p_expected_revision
  );
$function$;

create or replace function public.dnd_ai_approve_session_intelligence(
  p_campaign_id uuid,
  p_session_id uuid,
  p_expected_revision integer
)
returns jsonb
language sql
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_approve_session_intelligence(
    p_campaign_id, p_session_id, p_expected_revision
  );
$function$;

revoke all on function public.dnd_ai_session_intelligence(uuid,uuid) from public, anon;
revoke all on function public.dnd_ai_save_session_intelligence(uuid,uuid,jsonb,integer) from public, anon;
revoke all on function public.dnd_ai_approve_session_intelligence(uuid,uuid,integer) from public, anon;

grant execute on function public.dnd_ai_session_intelligence(uuid,uuid) to authenticated;
grant execute on function public.dnd_ai_save_session_intelligence(uuid,uuid,jsonb,integer) to authenticated;
grant execute on function public.dnd_ai_approve_session_intelligence(uuid,uuid,integer) to authenticated;

commit;
