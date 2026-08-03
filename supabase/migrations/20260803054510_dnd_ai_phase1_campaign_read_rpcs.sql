-- Filtered campaign reads. Rows containing GM-only columns are not exposed
-- directly to players; this RPC constructs a role-appropriate workspace.

begin;

create or replace function private.dnd_ai_campaign_list()
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $function$
  select jsonb_build_object(
    'campaigns',
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'tenantId', c.tenant_id,
          'name', c.name,
          'description', c.description,
          'status', c.status,
          'ruleset', c.ruleset,
          'currentLocation', c.current_location,
          'role', private.dnd_campaign_role(c.id),
          'createdAt', c.created_at,
          'updatedAt', c.updated_at
        ) order by c.updated_at desc
      ),
      '[]'::jsonb
    )
  )
  from public.dnd_campaigns c
  where auth.uid() is not null
    and private.dnd_can_view_campaign(c.id);
$function$;

create or replace function public.dnd_campaign_list()
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_campaign_list();
$function$;

create or replace function private.dnd_ai_campaign_workspace(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_role text;
  v_can_manage boolean;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  v_role := private.dnd_campaign_role(p_campaign_id);
  if v_role is null then
    raise exception 'Campaign not found or access denied' using errcode = '42501';
  end if;
  v_can_manage := v_role in ('admin', 'dm', 'assistant_dm');

  select jsonb_build_object(
    'role', v_role,
    'canManage', v_can_manage,
    'campaign', jsonb_build_object(
      'id', c.id,
      'tenant_id', c.tenant_id,
      'name', c.name,
      'description', c.description,
      'status', c.status,
      'ruleset', c.ruleset,
      'current_location', c.current_location,
      'active_quest_id', c.active_quest_id,
      'ai_state', case when v_can_manage then coalesce(c.metadata -> 'ai', '{}'::jsonb) else '{}'::jsonb end,
      'created_at', c.created_at,
      'updated_at', c.updated_at
    ),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id,
        'display_name', m.display_name,
        'role', m.role,
        'active', m.active
      ) order by m.created_at)
      from public.dnd_campaign_members m
      where m.campaign_id = p_campaign_id and m.active
    ), '[]'::jsonb),
    'characters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', ch.id,
        'name', ch.name,
        'player_name', coalesce(ch.metadata ->> 'playerName', ''),
        'summary', coalesce(ch.metadata ->> 'summary', ''),
        'level', ch.level,
        'class_name', ch.class_name,
        'hp', ch.hp,
        'max_hp', ch.max_hp,
        'armor_class', ch.armor_class,
        'conditions', ch.conditions,
        'inspiration', ch.inspiration,
        'exhaustion', ch.exhaustion,
        'status', ch.status,
        'initiative_modifier', ch.initiative_modifier,
        'selected', ch.selected,
        'revision', ch.revision
      ) order by ch.created_at)
      from public.dnd_characters ch
      where ch.campaign_id = p_campaign_id
    ), '[]'::jsonb),
    'npcs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', n.id,
        'name', n.name,
        'public_summary', n.public_summary,
        'gm_notes', case when v_can_manage then n.gm_notes else '' end,
        'revealed', n.revealed,
        'metadata', case when v_can_manage then n.metadata else coalesce(n.metadata -> 'public', '{}'::jsonb) end,
        'updated_at', n.updated_at
      ) order by n.updated_at desc)
      from public.dnd_npcs n
      where n.campaign_id = p_campaign_id and (v_can_manage or n.revealed)
    ), '[]'::jsonb),
    'locations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id,
        'name', l.name,
        'public_summary', l.public_summary,
        'gm_notes', case when v_can_manage then l.gm_notes else '' end,
        'revealed', l.revealed,
        'metadata', case when v_can_manage then l.metadata else coalesce(l.metadata -> 'public', '{}'::jsonb) end,
        'updated_at', l.updated_at
      ) order by l.updated_at desc)
      from public.dnd_locations l
      where l.campaign_id = p_campaign_id and (v_can_manage or l.revealed)
    ), '[]'::jsonb),
    'factions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id,
        'name', f.name,
        'public_summary', f.public_summary,
        'gm_notes', case when v_can_manage then f.gm_notes else '' end,
        'revealed', f.revealed,
        'metadata', case when v_can_manage then f.metadata else coalesce(f.metadata -> 'public', '{}'::jsonb) end,
        'updated_at', f.updated_at
      ) order by f.updated_at desc)
      from public.dnd_factions f
      where f.campaign_id = p_campaign_id and (v_can_manage or f.revealed)
    ), '[]'::jsonb),
    'quests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'title', q.title,
        'summary', q.summary,
        'gm_notes', case when v_can_manage then q.gm_notes else '' end,
        'status', q.status,
        'visible_to_players', q.visible_to_players,
        'metadata', case when v_can_manage then q.metadata else coalesce(q.metadata -> 'public', '{}'::jsonb) end,
        'updated_at', q.updated_at
      ) order by q.updated_at desc)
      from public.dnd_quests q
      where q.campaign_id = p_campaign_id and (v_can_manage or q.visible_to_players)
    ), '[]'::jsonb),
    'loot', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', lo.id,
        'name', lo.name,
        'quantity', lo.quantity,
        'shared', lo.shared,
        'gm_only', case when v_can_manage then lo.gm_only else false end,
        'assigned_character_id', lo.assigned_character_id,
        'metadata', case when v_can_manage then lo.metadata else coalesce(lo.metadata -> 'public', '{}'::jsonb) end,
        'updated_at', lo.updated_at
      ) order by lo.updated_at desc)
      from public.dnd_loot lo
      where lo.campaign_id = p_campaign_id
        and (
          v_can_manage
          or (
            not lo.gm_only
            and (
              lo.shared
              or exists (
                select 1 from public.dnd_characters own_ch
                where own_ch.id = lo.assigned_character_id
                  and own_ch.owner_user_id = auth.uid()
              )
            )
          )
        )
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'title', s.title,
        'status', s.status,
        'starts_at', s.starts_at,
        'ends_at', s.ends_at,
        'timezone', s.timezone,
        'agenda', s.agenda,
        'dm_notes', case when v_can_manage then s.dm_notes else '' end,
        'recap', case when v_can_manage or s.recap_approved_at is not null then s.recap_draft else '' end,
        'recap_approved_at', s.recap_approved_at,
        'updated_at', s.updated_at
      ) order by coalesce(s.starts_at, s.created_at) desc)
      from public.dnd_sessions s
      where s.campaign_id = p_campaign_id
        and (v_can_manage or s.recap_approved_at is not null)
    ), '[]'::jsonb),
    'encounters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'session_id', e.session_id,
        'name', e.name,
        'status', e.status,
        'round', e.round,
        'current_turn_index', e.current_turn_index,
        'metadata', case when v_can_manage then e.metadata else coalesce(e.metadata -> 'public', '{}'::jsonb) end,
        'combatants', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', ec.id,
            'character_id', ec.character_id,
            'npc_id', case when v_can_manage then ec.npc_id else null end,
            'name', ec.name_snapshot,
            'initiative', ec.initiative,
            'hp', ec.hp,
            'max_hp', ec.max_hp,
            'conditions', ec.conditions,
            'hidden', case when v_can_manage then ec.hidden else false end,
            'active', ec.active
          ) order by ec.initiative desc, ec.dexterity desc, ec.joined_at)
          from public.dnd_encounter_combatants ec
          where ec.encounter_id = e.id and ec.active and (v_can_manage or not ec.hidden)
        ), '[]'::jsonb),
        'updated_at', e.updated_at
      ) order by e.updated_at desc)
      from public.dnd_encounters e
      where e.campaign_id = p_campaign_id
        and (v_can_manage or e.status in ('active', 'completed'))
    ), '[]'::jsonb),
    'homebrew', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'entry_id', h.entry_id,
        'content_type', h.content_type,
        'name', h.name,
        'status', h.status,
        'revision', h.revision,
        'body', h.body,
        'approved_by', h.approved_by,
        'approved_at', h.approved_at,
        'created_at', h.created_at,
        'updated_at', h.updated_at
      ) order by h.updated_at desc)
      from public.dnd_homebrew h
      where h.campaign_id = p_campaign_id
        and (v_can_manage or h.status = 'approved' or h.author_user_id = auth.uid())
    ), '[]'::jsonb)
  ) into v_result
  from public.dnd_campaigns c
  where c.id = p_campaign_id;

  if v_result is null then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;
  return v_result;
end;
$function$;

create or replace function public.dnd_campaign_workspace(p_campaign_id uuid)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_campaign_workspace(p_campaign_id);
$function$;

revoke all on function private.dnd_ai_campaign_list() from public, anon;
revoke all on function private.dnd_ai_campaign_workspace(uuid) from public, anon;
grant execute on function private.dnd_ai_campaign_list() to authenticated;
grant execute on function private.dnd_ai_campaign_workspace(uuid) to authenticated;
revoke all on function public.dnd_campaign_list() from public, anon;
revoke all on function public.dnd_campaign_workspace(uuid) from public, anon;
grant execute on function public.dnd_campaign_list() to authenticated;
grant execute on function public.dnd_campaign_workspace(uuid) to authenticated;

commit;
