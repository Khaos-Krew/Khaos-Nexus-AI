-- Audited homebrew persistence and manager-only approval.

begin;

create or replace function private.dnd_ai_create_homebrew(
  p_campaign_id uuid,
  p_content_type text,
  p_name text,
  p_body jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_row public.dnd_homebrew%rowtype;
  v_tenant_id uuid;
begin
  if auth.uid() is null or not private.dnd_can_view_campaign(p_campaign_id) then
    raise exception 'Campaign access denied' using errcode = '42501';
  end if;

  select tenant_id into v_tenant_id from public.dnd_campaigns where id = p_campaign_id;
  if v_tenant_id is null then
    raise exception 'Campaign not found' using errcode = 'P0002';
  end if;

  insert into public.dnd_homebrew (
    campaign_id, author_user_id, content_type, name, status, revision, body
  ) values (
    p_campaign_id, auth.uid(), p_content_type, p_name, 'draft', 1, coalesce(p_body, '{}'::jsonb)
  ) returning * into v_row;

  insert into public.dnd_audit_log (
    tenant_id, campaign_id, actor_user_id, action, outcome,
    target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.homebrew.create', 'success',
    'homebrew', v_row.id::text, jsonb_build_object('contentType', p_content_type)
  );

  return jsonb_build_object(
    'id', v_row.id,
    'entry_id', v_row.entry_id,
    'campaign_id', v_row.campaign_id,
    'content_type', v_row.content_type,
    'name', v_row.name,
    'status', v_row.status,
    'revision', v_row.revision,
    'body', v_row.body,
    'approved_by', v_row.approved_by,
    'approved_at', v_row.approved_at,
    'created_at', v_row.created_at,
    'updated_at', v_row.updated_at
  );
end;
$function$;

create or replace function public.dnd_ai_create_homebrew(
  p_campaign_id uuid,
  p_content_type text,
  p_name text,
  p_body jsonb
)
returns jsonb
language sql
volatile
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_create_homebrew(p_campaign_id, p_content_type, p_name, p_body);
$function$;

create or replace function private.dnd_ai_approve_homebrew(
  p_campaign_id uuid,
  p_homebrew_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_row public.dnd_homebrew%rowtype;
  v_tenant_id uuid;
begin
  if auth.uid() is null or not private.dnd_can_manage_campaign(p_campaign_id) then
    raise exception 'Campaign management access denied' using errcode = '42501';
  end if;

  update public.dnd_homebrew h
  set status = 'approved',
      submitted_snapshot = h.body,
      approved_by = auth.uid(),
      approved_at = now(),
      revision = h.revision + 1,
      updated_at = now()
  where h.id = p_homebrew_id and h.campaign_id = p_campaign_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Homebrew entry not found' using errcode = 'P0002';
  end if;

  select tenant_id into v_tenant_id from public.dnd_campaigns where id = p_campaign_id;
  insert into public.dnd_audit_log (
    tenant_id, campaign_id, actor_user_id, action, outcome,
    target_type, target_id, metadata
  ) values (
    v_tenant_id, p_campaign_id, auth.uid(), 'ai.homebrew.approve', 'success',
    'homebrew', v_row.id::text, jsonb_build_object('revision', v_row.revision)
  );

  return jsonb_build_object(
    'id', v_row.id,
    'entry_id', v_row.entry_id,
    'campaign_id', v_row.campaign_id,
    'content_type', v_row.content_type,
    'name', v_row.name,
    'status', v_row.status,
    'revision', v_row.revision,
    'body', v_row.body,
    'approved_by', v_row.approved_by,
    'approved_at', v_row.approved_at,
    'created_at', v_row.created_at,
    'updated_at', v_row.updated_at
  );
end;
$function$;

create or replace function public.dnd_ai_approve_homebrew(
  p_campaign_id uuid,
  p_homebrew_id uuid
)
returns jsonb
language sql
volatile
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_approve_homebrew(p_campaign_id, p_homebrew_id);
$function$;

revoke all on function private.dnd_ai_create_homebrew(uuid,text,text,jsonb) from public, anon;
revoke all on function private.dnd_ai_approve_homebrew(uuid,uuid) from public, anon;
grant execute on function private.dnd_ai_create_homebrew(uuid,text,text,jsonb) to authenticated;
grant execute on function private.dnd_ai_approve_homebrew(uuid,uuid) to authenticated;
revoke all on function public.dnd_ai_create_homebrew(uuid,text,text,jsonb) from public, anon;
revoke all on function public.dnd_ai_approve_homebrew(uuid,uuid) from public, anon;
grant execute on function public.dnd_ai_create_homebrew(uuid,text,text,jsonb) to authenticated;
grant execute on function public.dnd_ai_approve_homebrew(uuid,uuid) to authenticated;

commit;
