begin;

create or replace function private.dnd_ai_player_scene_is_safe(p_scene jsonb)
returns boolean
language sql
immutable
set search_path = public, private, pg_temp
as $function$
  select
    p_scene is not null
    and jsonb_typeof(p_scene) = 'object'
    and p_scene ->> 'projection' = 'player'
    and coalesce(p_scene ->> 'gmNotes', '') = ''
    and not jsonb_path_exists(p_scene, '$.levels[*] ? (@.gmNotes != "")')
    and not jsonb_path_exists(p_scene, '$.levels[*].walls[*] ? (@.secret == true)')
    and not jsonb_path_exists(p_scene, '$.levels[*].doors[*] ? (@.secret == true)')
    and not jsonb_path_exists(p_scene, '$.levels[*].windows[*] ? (@.secret == true)')
    and not jsonb_path_exists(p_scene, '$.levels[*].terrain[*] ? (@.hidden == true)')
    and not jsonb_path_exists(p_scene, '$.levels[*].lights[*] ? (@.hidden == true)')
    and not jsonb_path_exists(p_scene, '$.levels[*].tokens[*] ? (@.hidden == true)')
    and not jsonb_path_exists(p_scene, '$.levels[*].pointsOfInterest[*] ? (@.secret == true || @.revealed == false)')
    and not jsonb_path_exists(p_scene, '$.levels[*].fogRegions[*] ? (@.revealed == false)');
$function$;

create or replace function private.dnd_ai_map_scenes(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_role text;
  v_can_manage boolean;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  v_role := private.dnd_campaign_role(p_campaign_id);
  if v_role is null then
    raise exception 'Campaign not found or access denied' using errcode = '42501';
  end if;
  v_can_manage := v_role in ('admin','dm','assistant_dm');

  return jsonb_build_object(
    'role', v_role,
    'canManage', v_can_manage,
    'scenes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'revision', s.revision,
        'approved', s.approved_at is not null,
        'approvedAt', s.approved_at,
        'updatedAt', s.updated_at,
        'schemaVersion', coalesce((s.gm_scene ->> 'schemaVersion')::integer, 1),
        'mapType', coalesce(s.gm_scene ->> 'mapType', ''),
        'levelCount', jsonb_array_length(coalesce(s.gm_scene -> 'levels', '[]'::jsonb))
      ) order by s.updated_at desc)
      from public.dnd_map_scenes s
      where s.campaign_id = p_campaign_id
        and s.active
        and (v_can_manage or s.approved_at is not null)
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function private.dnd_ai_map_scene(
  p_campaign_id uuid,
  p_scene_id uuid
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
  v_scene public.dnd_map_scenes%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  v_role := private.dnd_campaign_role(p_campaign_id);
  if v_role is null then
    raise exception 'Campaign not found or access denied' using errcode = '42501';
  end if;
  v_can_manage := v_role in ('admin','dm','assistant_dm');

  select * into v_scene
  from public.dnd_map_scenes
  where id = p_scene_id and campaign_id = p_campaign_id and active;

  if not found or (not v_can_manage and v_scene.approved_at is null) then
    raise exception 'Map scene not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'role', v_role,
    'canManage', v_can_manage,
    'scene', jsonb_build_object(
      'id', v_scene.id,
      'campaignId', v_scene.campaign_id,
      'name', v_scene.name,
      'sourceMap', case when v_can_manage then v_scene.source_map else null end,
      'gmScene', case when v_can_manage then v_scene.gm_scene else null end,
      'playerScene', v_scene.player_scene,
      'revision', v_scene.revision,
      'approved', v_scene.approved_at is not null,
      'approvedBy', case when v_can_manage then v_scene.approved_by else null end,
      'approvedAt', v_scene.approved_at,
      'metadata', case when v_can_manage then v_scene.metadata else '{}'::jsonb end,
      'createdAt', v_scene.created_at,
      'updatedAt', v_scene.updated_at
    )
  );
end;
$function$;

create or replace function private.dnd_ai_save_map_scene(
  p_campaign_id uuid,
  p_scene_id uuid,
  p_name text,
  p_source_map jsonb,
  p_gm_scene jsonb,
  p_player_scene jsonb,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_scene public.dnd_map_scenes%rowtype;
  v_tenant_id uuid;
  v_new_revision integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management permission is required' using errcode = '42501';
  end if;
  if nullif(btrim(p_name), '') is null or length(btrim(p_name)) > 300 then
    raise exception 'Scene name is required and must be 300 characters or fewer' using errcode = '22023';
  end if;
  if p_expected_revision is null or p_expected_revision < 0 then
    raise exception 'A valid expected revision is required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_source_map) <> 'object'
    or jsonb_typeof(p_gm_scene) <> 'object'
    or jsonb_typeof(p_player_scene) <> 'object'
  then
    raise exception 'Map scene payloads must be JSON objects' using errcode = '22023';
  end if;
  if p_gm_scene ->> 'projection' <> 'gm'
    or not private.dnd_ai_player_scene_is_safe(p_player_scene)
  then
    raise exception 'Map scene projections are invalid or unsafe' using errcode = '22023';
  end if;
  if p_gm_scene ->> 'id' is distinct from p_player_scene ->> 'id'
    or p_gm_scene ->> 'sourceMapHash' is distinct from p_player_scene ->> 'sourceMapHash'
    or p_gm_scene ->> 'schemaVersion' is distinct from p_player_scene ->> 'schemaVersion'
  then
    raise exception 'GM and player scenes must describe the same scene' using errcode = '22023';
  end if;
  if octet_length(p_source_map::text) > 600000
    or octet_length(p_gm_scene::text) > 1500000
    or octet_length(p_player_scene::text) > 1000000
  then
    raise exception 'Map scene payload exceeds allowed limits' using errcode = '22023';
  end if;

  select tenant_id into v_tenant_id
  from public.dnd_campaigns
  where id = p_campaign_id;

  if p_scene_id is null then
    if p_expected_revision <> 0 then
      raise exception 'New map scenes must use expected revision zero' using errcode = '22023';
    end if;
    insert into public.dnd_map_scenes(
      campaign_id, name, source_map, gm_scene, player_scene, revision,
      approved_by, approved_at, created_by, metadata
    ) values (
      p_campaign_id, btrim(p_name), p_source_map, p_gm_scene, p_player_scene, 1,
      null, null, auth.uid(), jsonb_build_object(
        'sourceMapHash', p_gm_scene ->> 'sourceMapHash',
        'sceneHash', encode(extensions.digest(p_gm_scene::text, 'sha256'), 'hex')
      )
    ) returning * into v_scene;
    v_new_revision := 1;
  else
    select * into v_scene
    from public.dnd_map_scenes
    where id = p_scene_id and campaign_id = p_campaign_id and active
    for update;

    if not found then
      raise exception 'Map scene not found' using errcode = 'P0002';
    end if;
    if v_scene.revision <> p_expected_revision then
      raise exception 'Map scene changed; reload before saving' using errcode = '40001';
    end if;
    v_new_revision := p_expected_revision + 1;
    update public.dnd_map_scenes
    set name = btrim(p_name),
        source_map = p_source_map,
        gm_scene = p_gm_scene,
        player_scene = p_player_scene,
        revision = v_new_revision,
        approved_by = null,
        approved_at = null,
        metadata = jsonb_build_object(
          'sourceMapHash', p_gm_scene ->> 'sourceMapHash',
          'sceneHash', encode(extensions.digest(p_gm_scene::text, 'sha256'), 'hex')
        ),
        updated_at = now()
    where id = p_scene_id
    returning * into v_scene;
  end if;

  insert into public.dnd_audit_log(
    tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.map_scene.saved',
    'map_scene', v_scene.id::text,
    jsonb_build_object('revision', v_new_revision, 'approvedReset', true)
  );

  return private.dnd_ai_map_scene(p_campaign_id, v_scene.id);
end;
$function$;

create or replace function private.dnd_ai_approve_map_scene(
  p_campaign_id uuid,
  p_scene_id uuid,
  p_expected_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_scene public.dnd_map_scenes%rowtype;
  v_tenant_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management permission is required' using errcode = '42501';
  end if;

  select * into v_scene
  from public.dnd_map_scenes
  where id = p_scene_id and campaign_id = p_campaign_id and active
  for update;

  if not found then
    raise exception 'Map scene not found' using errcode = 'P0002';
  end if;
  if p_expected_revision is null or p_expected_revision < 1
    or v_scene.revision <> p_expected_revision
  then
    raise exception 'Map scene changed; reload before approving' using errcode = '40001';
  end if;
  if not private.dnd_ai_player_scene_is_safe(v_scene.player_scene) then
    raise exception 'Player scene projection is unsafe' using errcode = '22023';
  end if;

  select tenant_id into v_tenant_id
  from public.dnd_campaigns
  where id = p_campaign_id;

  update public.dnd_map_scenes
  set approved_by = auth.uid(), approved_at = now(), updated_at = now()
  where id = p_scene_id
  returning * into v_scene;

  insert into public.dnd_audit_log(
    tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.map_scene.approved',
    'map_scene', p_scene_id::text,
    jsonb_build_object('revision', p_expected_revision)
  );

  return private.dnd_ai_map_scene(p_campaign_id, p_scene_id);
end;
$function$;

create or replace function public.dnd_ai_map_scenes(p_campaign_id uuid)
returns jsonb language sql stable set search_path = public, private, pg_temp
as $function$ select private.dnd_ai_map_scenes(p_campaign_id) $function$;

create or replace function public.dnd_ai_map_scene(p_campaign_id uuid, p_scene_id uuid)
returns jsonb language sql stable set search_path = public, private, pg_temp
as $function$ select private.dnd_ai_map_scene(p_campaign_id, p_scene_id) $function$;

create or replace function public.dnd_ai_save_map_scene(
  p_campaign_id uuid, p_scene_id uuid, p_name text, p_source_map jsonb,
  p_gm_scene jsonb, p_player_scene jsonb, p_expected_revision integer
)
returns jsonb language sql set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_save_map_scene(
    p_campaign_id, p_scene_id, p_name, p_source_map,
    p_gm_scene, p_player_scene, p_expected_revision
  )
$function$;

create or replace function public.dnd_ai_approve_map_scene(
  p_campaign_id uuid, p_scene_id uuid, p_expected_revision integer
)
returns jsonb language sql set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_approve_map_scene(p_campaign_id, p_scene_id, p_expected_revision)
$function$;

revoke all on function public.dnd_ai_map_scenes(uuid) from public, anon;
revoke all on function public.dnd_ai_map_scene(uuid,uuid) from public, anon;
revoke all on function public.dnd_ai_save_map_scene(uuid,uuid,text,jsonb,jsonb,jsonb,integer) from public, anon;
revoke all on function public.dnd_ai_approve_map_scene(uuid,uuid,integer) from public, anon;
revoke all on function private.dnd_ai_player_scene_is_safe(jsonb) from public, anon;
revoke all on function private.dnd_ai_map_scenes(uuid) from public, anon;
revoke all on function private.dnd_ai_map_scene(uuid,uuid) from public, anon;
revoke all on function private.dnd_ai_save_map_scene(uuid,uuid,text,jsonb,jsonb,jsonb,integer) from public, anon;
revoke all on function private.dnd_ai_approve_map_scene(uuid,uuid,integer) from public, anon;

grant execute on function public.dnd_ai_map_scenes(uuid) to authenticated;
grant execute on function public.dnd_ai_map_scene(uuid,uuid) to authenticated;
grant execute on function public.dnd_ai_save_map_scene(uuid,uuid,text,jsonb,jsonb,jsonb,integer) to authenticated;
grant execute on function public.dnd_ai_approve_map_scene(uuid,uuid,integer) to authenticated;
grant execute on function private.dnd_ai_player_scene_is_safe(jsonb) to authenticated;
grant execute on function private.dnd_ai_map_scenes(uuid) to authenticated;
grant execute on function private.dnd_ai_map_scene(uuid,uuid) to authenticated;
grant execute on function private.dnd_ai_save_map_scene(uuid,uuid,text,jsonb,jsonb,jsonb,integer) to authenticated;
grant execute on function private.dnd_ai_approve_map_scene(uuid,uuid,integer) to authenticated;

commit;
