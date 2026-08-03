-- Khaos Nexus AI Phase 2: controlled campaign workspace tools.
-- Generation and mutation remain separate. Only authenticated campaign managers
-- can invoke this fixed allow-list; arbitrary SQL/table names are never accepted.

begin;

create or replace function private.dnd_ai_execute_workspace_tool(
  p_campaign_id uuid,
  p_tool text,
  p_arguments jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private, extensions, pg_temp
as $function$
declare
  v_id uuid;
  v_tenant_id uuid;
  v_record jsonb;
  v_target_type text;
  v_target_id text;
begin
  if auth.uid() is null or not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management access denied' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_arguments, '{}'::jsonb)) <> 'object' then
    raise exception 'Tool arguments must be a JSON object' using errcode = '22023';
  end if;

  select tenant_id into v_tenant_id
  from public.dnd_campaigns
  where id = p_campaign_id;
  if v_tenant_id is null then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;

  v_id := nullif(p_arguments ->> 'id', '')::uuid;

  case p_tool
    when 'upsert_npc' then
      insert into public.dnd_npcs as n (
        id, campaign_id, name, public_summary, gm_notes, revealed, metadata
      ) values (
        coalesce(v_id, extensions.gen_random_uuid()),
        p_campaign_id,
        nullif(btrim(p_arguments ->> 'name'), ''),
        coalesce(p_arguments ->> 'publicSummary', ''),
        coalesce(p_arguments ->> 'gmNotes', ''),
        coalesce((p_arguments ->> 'revealed')::boolean, false),
        coalesce(p_arguments -> 'metadata', '{}'::jsonb)
      )
      on conflict (id) do update set
        name = excluded.name,
        public_summary = excluded.public_summary,
        gm_notes = excluded.gm_notes,
        revealed = excluded.revealed,
        metadata = excluded.metadata,
        updated_at = now()
      where n.campaign_id = p_campaign_id
      returning to_jsonb(n.*) into v_record;
      v_target_type := 'npc';

    when 'upsert_location' then
      insert into public.dnd_locations as l (
        id, campaign_id, name, public_summary, gm_notes, revealed, metadata
      ) values (
        coalesce(v_id, extensions.gen_random_uuid()), p_campaign_id,
        nullif(btrim(p_arguments ->> 'name'), ''),
        coalesce(p_arguments ->> 'publicSummary', ''),
        coalesce(p_arguments ->> 'gmNotes', ''),
        coalesce((p_arguments ->> 'revealed')::boolean, false),
        coalesce(p_arguments -> 'metadata', '{}'::jsonb)
      )
      on conflict (id) do update set
        name = excluded.name,
        public_summary = excluded.public_summary,
        gm_notes = excluded.gm_notes,
        revealed = excluded.revealed,
        metadata = excluded.metadata,
        updated_at = now()
      where l.campaign_id = p_campaign_id
      returning to_jsonb(l.*) into v_record;
      v_target_type := 'location';

    when 'upsert_faction' then
      insert into public.dnd_factions as f (
        id, campaign_id, name, public_summary, gm_notes, revealed, metadata
      ) values (
        coalesce(v_id, extensions.gen_random_uuid()), p_campaign_id,
        nullif(btrim(p_arguments ->> 'name'), ''),
        coalesce(p_arguments ->> 'publicSummary', ''),
        coalesce(p_arguments ->> 'gmNotes', ''),
        coalesce((p_arguments ->> 'revealed')::boolean, false),
        coalesce(p_arguments -> 'metadata', '{}'::jsonb)
      )
      on conflict (id) do update set
        name = excluded.name,
        public_summary = excluded.public_summary,
        gm_notes = excluded.gm_notes,
        revealed = excluded.revealed,
        metadata = excluded.metadata,
        updated_at = now()
      where f.campaign_id = p_campaign_id
      returning to_jsonb(f.*) into v_record;
      v_target_type := 'faction';

    when 'upsert_quest' then
      insert into public.dnd_quests as q (
        id, campaign_id, title, summary, gm_notes, status,
        visible_to_players, metadata
      ) values (
        coalesce(v_id, extensions.gen_random_uuid()), p_campaign_id,
        nullif(btrim(p_arguments ->> 'title'), ''),
        coalesce(p_arguments ->> 'summary', ''),
        coalesce(p_arguments ->> 'gmNotes', ''),
        coalesce(nullif(p_arguments ->> 'status', ''), 'draft'),
        coalesce((p_arguments ->> 'visibleToPlayers')::boolean, false),
        coalesce(p_arguments -> 'metadata', '{}'::jsonb)
      )
      on conflict (id) do update set
        title = excluded.title,
        summary = excluded.summary,
        gm_notes = excluded.gm_notes,
        status = excluded.status,
        visible_to_players = excluded.visible_to_players,
        metadata = excluded.metadata,
        updated_at = now()
      where q.campaign_id = p_campaign_id
      returning to_jsonb(q.*) into v_record;
      v_target_type := 'quest';

    when 'upsert_loot' then
      if nullif(p_arguments ->> 'assignedCharacterId', '') is not null
         and not exists (
           select 1 from public.dnd_characters c
           where c.id = (p_arguments ->> 'assignedCharacterId')::uuid
             and c.campaign_id = p_campaign_id
         ) then
        raise exception 'Assigned character is not in this campaign' using errcode = '22023';
      end if;
      insert into public.dnd_loot as lo (
        id, campaign_id, name, quantity, shared, gm_only,
        assigned_character_id, metadata
      ) values (
        coalesce(v_id, extensions.gen_random_uuid()), p_campaign_id,
        nullif(btrim(p_arguments ->> 'name'), ''),
        coalesce((p_arguments ->> 'quantity')::numeric, 1),
        coalesce((p_arguments ->> 'shared')::boolean, true),
        coalesce((p_arguments ->> 'gmOnly')::boolean, false),
        nullif(p_arguments ->> 'assignedCharacterId', '')::uuid,
        coalesce(p_arguments -> 'metadata', '{}'::jsonb)
      )
      on conflict (id) do update set
        name = excluded.name,
        quantity = excluded.quantity,
        shared = excluded.shared,
        gm_only = excluded.gm_only,
        assigned_character_id = excluded.assigned_character_id,
        metadata = excluded.metadata,
        updated_at = now()
      where lo.campaign_id = p_campaign_id
      returning to_jsonb(lo.*) into v_record;
      v_target_type := 'loot';

    when 'upsert_session' then
      insert into public.dnd_sessions as s (
        id, campaign_id, title, status, starts_at, ends_at, timezone,
        agenda, dm_notes, recap_draft, metadata
      ) values (
        coalesce(v_id, extensions.gen_random_uuid()), p_campaign_id,
        nullif(btrim(p_arguments ->> 'title'), ''),
        coalesce(nullif(p_arguments ->> 'status', ''), 'planned'),
        nullif(p_arguments ->> 'startsAt', '')::timestamptz,
        nullif(p_arguments ->> 'endsAt', '')::timestamptz,
        coalesce(nullif(p_arguments ->> 'timezone', ''), 'UTC'),
        coalesce(p_arguments ->> 'agenda', ''),
        coalesce(p_arguments ->> 'dmNotes', ''),
        coalesce(p_arguments ->> 'recapDraft', ''),
        coalesce(p_arguments -> 'metadata', '{}'::jsonb)
      )
      on conflict (id) do update set
        title = excluded.title,
        status = excluded.status,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        timezone = excluded.timezone,
        agenda = excluded.agenda,
        dm_notes = excluded.dm_notes,
        recap_draft = excluded.recap_draft,
        metadata = excluded.metadata,
        recap_approved_by = case
          when s.recap_draft is distinct from excluded.recap_draft then null
          else s.recap_approved_by
        end,
        recap_approved_at = case
          when s.recap_draft is distinct from excluded.recap_draft then null
          else s.recap_approved_at
        end,
        updated_at = now()
      where s.campaign_id = p_campaign_id
      returning to_jsonb(s.*) into v_record;
      v_target_type := 'session';

    when 'approve_session_recap' then
      update public.dnd_sessions s
      set recap_approved_by = auth.uid(),
          recap_approved_at = now(),
          updated_at = now()
      where s.id = (p_arguments ->> 'sessionId')::uuid
        and s.campaign_id = p_campaign_id
      returning to_jsonb(s.*) into v_record;
      v_target_type := 'session';

    when 'upsert_calendar_event' then
      if nullif(p_arguments ->> 'sessionId', '') is not null
         and not exists (
           select 1 from public.dnd_sessions s
           where s.id = (p_arguments ->> 'sessionId')::uuid
             and s.campaign_id = p_campaign_id
         ) then
        raise exception 'Session is not in this campaign' using errcode = '22023';
      end if;
      insert into public.dnd_calendar_events as ce (
        id, campaign_id, session_id, title, starts_at, ends_at,
        timezone, visibility, metadata
      ) values (
        coalesce(v_id, extensions.gen_random_uuid()), p_campaign_id,
        nullif(p_arguments ->> 'sessionId', '')::uuid,
        nullif(btrim(p_arguments ->> 'title'), ''),
        (p_arguments ->> 'startsAt')::timestamptz,
        nullif(p_arguments ->> 'endsAt', '')::timestamptz,
        coalesce(nullif(p_arguments ->> 'timezone', ''), 'UTC'),
        coalesce(nullif(p_arguments ->> 'visibility', ''), 'campaign'),
        coalesce(p_arguments -> 'metadata', '{}'::jsonb)
      )
      on conflict (id) do update set
        session_id = excluded.session_id,
        title = excluded.title,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        timezone = excluded.timezone,
        visibility = excluded.visibility,
        metadata = excluded.metadata,
        updated_at = now()
      where ce.campaign_id = p_campaign_id
      returning to_jsonb(ce.*) into v_record;
      v_target_type := 'calendar_event';

    else
      raise exception 'Unsupported workspace tool: %', p_tool using errcode = '22023';
  end case;

  if v_record is null then
    raise exception 'Workspace record not found or campaign mismatch' using errcode = 'P0002';
  end if;

  v_target_id := v_record ->> 'id';
  insert into public.dnd_audit_log (
    tenant_id, campaign_id, actor_user_id, action, outcome,
    target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(),
    'ai.workspace.' || p_tool, 'success', v_target_type, v_target_id,
    jsonb_build_object('tool', p_tool, 'source', 'khaos-nexus-ai')
  );

  return jsonb_build_object(
    'tool', p_tool,
    'targetType', v_target_type,
    'targetId', v_target_id,
    'record', v_record
  );
end;
$function$;

create or replace function public.dnd_ai_execute_workspace_tool(
  p_campaign_id uuid,
  p_tool text,
  p_arguments jsonb
)
returns jsonb
language sql
volatile
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_execute_workspace_tool(p_campaign_id, p_tool, p_arguments);
$function$;

revoke all on function private.dnd_ai_execute_workspace_tool(uuid,text,jsonb) from public, anon;
grant execute on function private.dnd_ai_execute_workspace_tool(uuid,text,jsonb) to authenticated;
revoke all on function public.dnd_ai_execute_workspace_tool(uuid,text,jsonb) from public, anon;
grant execute on function public.dnd_ai_execute_workspace_tool(uuid,text,jsonb) to authenticated;

commit;
