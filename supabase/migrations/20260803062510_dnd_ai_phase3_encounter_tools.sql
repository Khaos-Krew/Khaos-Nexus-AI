-- Phase 3B: fixed encounter-tool allow-list with transaction locks and audit events.
begin;

create or replace function private.dnd_ai_execute_encounter_tool(
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
  v_can_manage boolean;
  v_owns_combatant boolean := false;
  v_tenant_id uuid;
  v_encounter_id uuid;
  v_combatant_id uuid;
  v_encounter public.dnd_encounters%rowtype;
  v_combatant public.dnd_encounter_combatants%rowtype;
  v_order uuid[];
  v_count integer;
  v_next integer;
  v_amount integer;
  v_absorbed integer;
  v_condition text;
  v_record jsonb;
  v_target_type text;
  v_target_id text;
  v_name text;
  v_hp integer;
  v_max_hp integer;
  v_armor_class integer;
begin
  if auth.uid() is null or not private.dnd_can_view_campaign(p_campaign_id) then
    raise exception 'Campaign access denied' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_arguments, '{}'::jsonb)) <> 'object' then
    raise exception 'Tool arguments must be a JSON object' using errcode = '22023';
  end if;

  v_can_manage := private.dnd_can_manage_campaign(p_campaign_id);
  select tenant_id into v_tenant_id from public.dnd_campaigns where id = p_campaign_id;
  v_encounter_id := nullif(p_arguments ->> 'encounterId', '')::uuid;
  v_combatant_id := nullif(p_arguments ->> 'combatantId', '')::uuid;

  if v_combatant_id is not null then
    select * into v_combatant
    from public.dnd_encounter_combatants c
    where c.id = v_combatant_id and c.campaign_id = p_campaign_id
    for update;
    if v_combatant.id is null then
      raise exception 'Combatant not found' using errcode = 'P0002';
    end if;
    v_encounter_id := v_combatant.encounter_id;
    v_owns_combatant := v_combatant.character_id is not null and exists (
      select 1 from public.dnd_characters ch
      where ch.id = v_combatant.character_id
        and ch.campaign_id = p_campaign_id
        and ch.owner_user_id = auth.uid()
    );
  end if;

  if not v_can_manage and not (
    v_owns_combatant and p_tool in ('set_concentration', 'set_reaction', 'record_death_save')
  ) then
    raise exception 'Encounter management access denied' using errcode = '42501';
  end if;

  case p_tool
    when 'create_encounter' then
      if not v_can_manage then raise exception 'Encounter management access denied' using errcode='42501'; end if;
      if nullif(p_arguments ->> 'sessionId', '') is not null and not exists (
        select 1 from public.dnd_sessions s
        where s.id = (p_arguments ->> 'sessionId')::uuid and s.campaign_id = p_campaign_id
      ) then raise exception 'Session is not in this campaign' using errcode='22023'; end if;
      insert into public.dnd_encounters (campaign_id, session_id, name, status, round, current_turn_index, metadata)
      values (p_campaign_id, nullif(p_arguments ->> 'sessionId','')::uuid,
        nullif(btrim(p_arguments ->> 'name'),''), coalesce(nullif(p_arguments ->> 'status',''),'draft'),
        1, 0, coalesce(p_arguments -> 'metadata','{}'::jsonb))
      returning * into v_encounter;
      v_encounter_id := v_encounter.id;
      v_record := to_jsonb(v_encounter);
      v_target_type := 'encounter';

    when 'set_encounter_status' then
      select * into v_encounter from public.dnd_encounters e
      where e.id=v_encounter_id and e.campaign_id=p_campaign_id for update;
      if v_encounter.id is null then raise exception 'Encounter not found' using errcode='P0002'; end if;
      if p_arguments ->> 'status' = 'active' and not exists (
        select 1 from public.dnd_encounter_combatants c where c.encounter_id=v_encounter_id and c.active
      ) then raise exception 'Cannot start an encounter without active combatants' using errcode='22023'; end if;
      update public.dnd_encounters e set status=p_arguments->>'status',
        round=case when p_arguments->>'status'='active' and e.status<>'active' then 1 else e.round end,
        current_turn_index=case when p_arguments->>'status'='active' and e.status<>'active' then 0 else e.current_turn_index end,
        updated_at=now()
      where e.id=v_encounter_id returning * into v_encounter;
      v_record:=to_jsonb(v_encounter); v_target_type:='encounter';

    when 'add_combatant' then
      select * into v_encounter from public.dnd_encounters e
      where e.id=v_encounter_id and e.campaign_id=p_campaign_id for update;
      if v_encounter.id is null then raise exception 'Encounter not found' using errcode='P0002'; end if;
      v_name := nullif(btrim(p_arguments ->> 'name'),'');
      v_hp := nullif(p_arguments ->> 'hp','')::integer;
      v_max_hp := nullif(p_arguments ->> 'maxHp','')::integer;
      v_armor_class := nullif(p_arguments ->> 'armorClass','')::integer;
      if nullif(p_arguments ->> 'characterId','') is not null then
        select coalesce(v_name,ch.name),coalesce(v_hp,ch.hp),coalesce(v_max_hp,ch.max_hp),coalesce(v_armor_class,ch.armor_class)
        into v_name,v_hp,v_max_hp,v_armor_class
        from public.dnd_characters ch
        where ch.id=(p_arguments->>'characterId')::uuid and ch.campaign_id=p_campaign_id;
        if v_name is null then raise exception 'Character is not in this campaign' using errcode='22023'; end if;
      elsif nullif(p_arguments ->> 'npcId','') is not null then
        select coalesce(v_name,n.name) into v_name from public.dnd_npcs n
        where n.id=(p_arguments->>'npcId')::uuid and n.campaign_id=p_campaign_id;
        if v_name is null then raise exception 'NPC is not in this campaign' using errcode='22023'; end if;
      elsif v_name is null then
        raise exception 'Custom combatants require a name' using errcode='22023';
      end if;
      if v_max_hp is not null and v_hp is null then v_hp:=v_max_hp; end if;
      insert into public.dnd_encounter_combatants (
        encounter_id,campaign_id,character_id,npc_id,name_snapshot,initiative,dexterity,
        hp,max_hp,temp_hp,armor_class,hidden,active,legendary_actions_max,
        legendary_actions_remaining,is_lair_actor,metadata
      ) values (
        v_encounter_id,p_campaign_id,nullif(p_arguments->>'characterId','')::uuid,
        nullif(p_arguments->>'npcId','')::uuid,v_name,coalesce((p_arguments->>'initiative')::integer,0),
        coalesce((p_arguments->>'dexterity')::integer,0),v_hp,v_max_hp,
        coalesce((p_arguments->>'tempHp')::integer,0),v_armor_class,
        coalesce((p_arguments->>'hidden')::boolean,false),true,
        coalesce((p_arguments->>'legendaryActionsMax')::integer,0),
        coalesce((p_arguments->>'legendaryActionsMax')::integer,0),
        coalesce((p_arguments->>'isLairActor')::boolean,false),
        coalesce(p_arguments->'metadata','{}'::jsonb) || jsonb_build_object('team',coalesce(p_arguments->>'team','neutral'))
      ) returning * into v_combatant;
      v_combatant_id:=v_combatant.id; v_record:=to_jsonb(v_combatant); v_target_type:='combatant';

    when 'set_initiative' then
      update public.dnd_encounter_combatants c set initiative=(p_arguments->>'initiative')::integer,
        dexterity=coalesce((p_arguments->>'dexterity')::integer,c.dexterity),revision=c.revision+1,updated_at=now()
      where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant); v_target_type:='combatant';

    when 'advance_turn', 'rewind_turn' then
      select * into v_encounter from public.dnd_encounters e
      where e.id=v_encounter_id and e.campaign_id=p_campaign_id for update;
      if v_encounter.id is null then raise exception 'Encounter not found' using errcode='P0002'; end if;
      select array_agg(c.id order by c.initiative desc,c.dexterity desc,c.joined_at,c.id)
      into v_order from public.dnd_encounter_combatants c where c.encounter_id=v_encounter_id and c.active;
      v_count:=coalesce(array_length(v_order,1),0);
      if v_count=0 then raise exception 'Encounter has no active combatants' using errcode='22023'; end if;
      if p_tool='advance_turn' then
        v_next:=v_encounter.current_turn_index+1;
        if v_next>=v_count then v_next:=0; v_encounter.round:=v_encounter.round+1; end if;
      else
        v_next:=v_encounter.current_turn_index-1;
        if v_next<0 then v_next:=v_count-1; v_encounter.round:=greatest(1,v_encounter.round-1); end if;
      end if;
      update public.dnd_encounters e set round=v_encounter.round,current_turn_index=v_next,updated_at=now()
      where e.id=v_encounter_id returning * into v_encounter;
      update public.dnd_encounter_combatants c set reaction_available=true,
        legendary_actions_remaining=legendary_actions_max,revision=revision+1,updated_at=now()
      where c.id=v_order[v_next+1];
      v_record:=private.dnd_ai_encounter_state(p_campaign_id,v_encounter_id); v_target_type:='encounter';

    when 'apply_damage' then
      if v_combatant.hp is null then raise exception 'Combatant does not track HP' using errcode='22023'; end if;
      v_amount:=(p_arguments->>'amount')::integer;
      v_absorbed:=least(v_combatant.temp_hp,v_amount);
      update public.dnd_encounter_combatants c set temp_hp=c.temp_hp-v_absorbed,
        hp=greatest(0,c.hp-(v_amount-v_absorbed)),revision=c.revision+1,updated_at=now()
      where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant)||jsonb_build_object('absorbedByTempHp',v_absorbed);v_target_type:='combatant';

    when 'heal' then
      if v_combatant.hp is null then raise exception 'Combatant does not track HP' using errcode='22023'; end if;
      v_amount:=(p_arguments->>'amount')::integer;
      update public.dnd_encounter_combatants c set hp=case when c.max_hp is null then c.hp+v_amount else least(c.max_hp,c.hp+v_amount) end,
        revision=c.revision+1,updated_at=now() where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    when 'set_combatant_stats' then
      update public.dnd_encounter_combatants c set
        hp=case when p_arguments ? 'hp' then (p_arguments->>'hp')::integer else c.hp end,
        max_hp=case when p_arguments ? 'maxHp' then (p_arguments->>'maxHp')::integer else c.max_hp end,
        temp_hp=case when p_arguments ? 'tempHp' then (p_arguments->>'tempHp')::integer else c.temp_hp end,
        armor_class=case when p_arguments ? 'armorClass' then (p_arguments->>'armorClass')::integer else c.armor_class end,
        revision=c.revision+1,updated_at=now()
      where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    when 'add_condition' then
      v_condition:=lower(btrim(p_arguments->>'condition'));
      update public.dnd_encounter_combatants c set
        conditions=array(select distinct x from unnest(c.conditions||array[v_condition]) x order by x),
        metadata=jsonb_set(c.metadata,'{conditionDetails}',coalesce(c.metadata->'conditionDetails','{}'::jsonb)||jsonb_build_object(v_condition,coalesce(p_arguments->'details','{}'::jsonb)),true),
        revision=c.revision+1,updated_at=now()
      where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    when 'remove_condition' then
      v_condition:=lower(btrim(p_arguments->>'condition'));
      update public.dnd_encounter_combatants c set
        conditions=array_remove(c.conditions,v_condition),
        metadata=jsonb_set(c.metadata,'{conditionDetails}',coalesce(c.metadata->'conditionDetails','{}'::jsonb)-v_condition,true),
        revision=c.revision+1,updated_at=now()
      where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    when 'set_concentration' then
      update public.dnd_encounter_combatants c set concentration=case when (p_arguments->>'active')::boolean then
        jsonb_build_object('active',true,'effect',coalesce(p_arguments->>'effect',''),'source',coalesce(p_arguments->>'source',''),'startedAt',now()) else '{}'::jsonb end,
        revision=c.revision+1,updated_at=now() where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    when 'set_reaction' then
      update public.dnd_encounter_combatants c set reaction_available=(p_arguments->>'available')::boolean,
        revision=c.revision+1,updated_at=now() where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    when 'record_death_save' then
      update public.dnd_encounter_combatants c set
        death_save_successes=case p_arguments->>'outcome'
          when 'success' then least(3,c.death_save_successes+1)
          when 'natural-20' then 0 when 'reset' then 0 else c.death_save_successes end,
        death_save_failures=case p_arguments->>'outcome'
          when 'failure' then least(3,c.death_save_failures+1)
          when 'natural-1' then least(3,c.death_save_failures+2)
          when 'natural-20' then 0 when 'reset' then 0 else c.death_save_failures end,
        hp=case when p_arguments->>'outcome'='natural-20' then greatest(1,coalesce(c.hp,0)) else c.hp end,
        revision=c.revision+1,updated_at=now()
      where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    when 'set_legendary_actions' then
      update public.dnd_encounter_combatants c set legendary_actions_max=(p_arguments->>'maximum')::integer,
        legendary_actions_remaining=(p_arguments->>'remaining')::integer,revision=c.revision+1,updated_at=now()
      where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    when 'set_combatant_visibility' then
      update public.dnd_encounter_combatants c set hidden=(p_arguments->>'hidden')::boolean,
        active=(p_arguments->>'active')::boolean,removed_at=case when (p_arguments->>'active')::boolean then null else now() end,
        revision=c.revision+1,updated_at=now() where c.id=v_combatant_id returning * into v_combatant;
      v_record:=to_jsonb(v_combatant);v_target_type:='combatant';

    else
      raise exception 'Unsupported encounter tool: %',p_tool using errcode='22023';
  end case;

  v_target_id:=case when v_target_type='encounter' then v_encounter_id::text else coalesce(v_combatant_id::text,v_record->>'id') end;
  insert into public.dnd_audit_log (tenant_id,campaign_id,actor_user_id,action,outcome,target_type,target_id,metadata)
  values (v_tenant_id,p_campaign_id,auth.uid(),'ai.encounter.'||p_tool,'success',v_target_type,v_target_id,
    jsonb_build_object('tool',p_tool,'encounterId',v_encounter_id,'source','khaos-nexus-ai'));

  return jsonb_build_object('tool',p_tool,'targetType',v_target_type,'targetId',v_target_id,'encounterId',v_encounter_id,'result',v_record);
end;
$function$;

create or replace function public.dnd_ai_execute_encounter_tool(p_campaign_id uuid,p_tool text,p_arguments jsonb)
returns jsonb
language sql
volatile
set search_path=public,private,pg_temp
as $function$
  select private.dnd_ai_execute_encounter_tool(p_campaign_id,p_tool,p_arguments);
$function$;

revoke all on function private.dnd_ai_execute_encounter_tool(uuid,text,jsonb) from public,anon;
grant execute on function private.dnd_ai_execute_encounter_tool(uuid,text,jsonb) to authenticated;
revoke all on function public.dnd_ai_execute_encounter_tool(uuid,text,jsonb) from public,anon;
grant execute on function public.dnd_ai_execute_encounter_tool(uuid,text,jsonb) to authenticated;

commit;
