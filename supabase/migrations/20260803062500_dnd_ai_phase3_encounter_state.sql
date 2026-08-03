-- Phase 3A: combat fields, initiative index, and role-filtered encounter state.
begin;

alter table public.dnd_encounter_combatants
  add column if not exists temp_hp integer not null default 0 check (temp_hp >= 0),
  add column if not exists armor_class integer check (armor_class is null or armor_class >= 0),
  add column if not exists concentration jsonb not null default '{}'::jsonb,
  add column if not exists reaction_available boolean not null default true,
  add column if not exists death_save_successes integer not null default 0 check (death_save_successes between 0 and 3),
  add column if not exists death_save_failures integer not null default 0 check (death_save_failures between 0 and 3),
  add column if not exists legendary_actions_max integer not null default 0 check (legendary_actions_max between 0 and 10),
  add column if not exists legendary_actions_remaining integer not null default 0 check (legendary_actions_remaining between 0 and 10),
  add column if not exists is_lair_actor boolean not null default false,
  add column if not exists revision integer not null default 1 check (revision > 0),
  add column if not exists updated_at timestamptz not null default now();

create index if not exists dnd_combatants_initiative_order_idx
  on public.dnd_encounter_combatants
  (encounter_id, active, initiative desc, dexterity desc, joined_at, id);

create or replace function private.dnd_ai_encounter_state(
  p_campaign_id uuid,
  p_encounter_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_can_manage boolean;
  v_result jsonb;
begin
  if auth.uid() is null or not private.dnd_can_view_campaign(p_campaign_id) then
    raise exception 'Campaign access denied' using errcode = '42501';
  end if;
  v_can_manage := private.dnd_can_manage_campaign(p_campaign_id);

  select jsonb_build_object(
    'canManage', v_can_manage,
    'encounter', jsonb_build_object(
      'id', e.id,
      'campaignId', e.campaign_id,
      'sessionId', e.session_id,
      'name', e.name,
      'status', e.status,
      'round', e.round,
      'currentTurnIndex', e.current_turn_index,
      'metadata', case when v_can_manage then e.metadata else coalesce(e.metadata -> 'public', '{}'::jsonb) end,
      'createdAt', e.created_at,
      'updatedAt', e.updated_at
    ),
    'combatants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id,
        'characterId', c.character_id,
        'npcId', case when v_can_manage then c.npc_id else null end,
        'name', c.name_snapshot,
        'initiative', c.initiative,
        'dexterity', c.dexterity,
        'hp', c.hp,
        'maxHp', case when v_can_manage or c.character_id is not null then c.max_hp else null end,
        'tempHp', c.temp_hp,
        'armorClass', case when v_can_manage or c.character_id is not null then c.armor_class else null end,
        'conditions', c.conditions,
        'concentration', c.concentration,
        'reactionAvailable', c.reaction_available,
        'deathSaveSuccesses', c.death_save_successes,
        'deathSaveFailures', c.death_save_failures,
        'legendaryActionsMax', case when v_can_manage then c.legendary_actions_max else 0 end,
        'legendaryActionsRemaining', case when v_can_manage then c.legendary_actions_remaining else 0 end,
        'isLairActor', case when v_can_manage then c.is_lair_actor else false end,
        'hidden', case when v_can_manage then c.hidden else false end,
        'active', c.active,
        'metadata', case when v_can_manage then c.metadata else coalesce(c.metadata -> 'public', '{}'::jsonb) end,
        'revision', c.revision,
        'updatedAt', c.updated_at
      ) order by c.initiative desc, c.dexterity desc, c.joined_at, c.id)
      from public.dnd_encounter_combatants c
      where c.encounter_id = e.id
        and c.active
        and (v_can_manage or not c.hidden)
    ), '[]'::jsonb)
  ) into v_result
  from public.dnd_encounters e
  where e.id = p_encounter_id
    and e.campaign_id = p_campaign_id
    and (v_can_manage or e.status in ('active', 'completed'));

  if v_result is null then
    raise exception 'Encounter not found or access denied' using errcode = 'P0002';
  end if;
  return v_result;
end;
$function$;

create or replace function public.dnd_ai_encounter_state(p_campaign_id uuid, p_encounter_id uuid)
returns jsonb
language sql
stable
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_encounter_state(p_campaign_id, p_encounter_id);
$function$;

revoke all on function private.dnd_ai_encounter_state(uuid,uuid) from public,anon;
grant execute on function private.dnd_ai_encounter_state(uuid,uuid) to authenticated;
revoke all on function public.dnd_ai_encounter_state(uuid,uuid) from public,anon;
grant execute on function public.dnd_ai_encounter_state(uuid,uuid) to authenticated;

commit;
