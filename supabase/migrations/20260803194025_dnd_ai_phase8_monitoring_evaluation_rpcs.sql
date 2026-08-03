begin;

create or replace function private.dnd_ai_usage(p_campaign_id uuid,p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,private,pg_temp
as $function$
declare
  v_tenant uuid;
  v_limit integer;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode='42501'; end if;
  v_limit:=greatest(1,least(coalesce(p_limit,100),500));
  v_tenant:=private.dnd_ai_scope_tenant(p_campaign_id);
  if (p_campaign_id is not null and not private.dnd_can_manage_campaign(p_campaign_id))
     or (p_campaign_id is null and not private.dnd_ai_can_manage_tenant(v_tenant)) then
    raise exception 'Management permission is required' using errcode='42501';
  end if;
  return jsonb_build_object(
    'canManage',true,
    'summary',(
      select jsonb_build_object(
        'requests',count(*) filter(where status<>'blocked'),
        'blocked',count(*) filter(where status='blocked'),
        'inputTokens',coalesce(sum(input_tokens),0),
        'outputTokens',coalesce(sum(output_tokens),0),
        'costMicros',coalesce(sum(cost_micros),0),
        'averageLatencyMs',coalesce(round(avg(latency_ms) filter(where latency_ms is not null)),0)
      ) from public.dnd_ai_usage_events e
      where e.tenant_id=v_tenant and (p_campaign_id is null or e.campaign_id=p_campaign_id)
    ),
    'events',coalesce((
      select jsonb_agg(private.dnd_ai_usage_event_json(e) order by e.created_at desc)
      from (
        select * from public.dnd_ai_usage_events e
        where e.tenant_id=v_tenant and (p_campaign_id is null or e.campaign_id=p_campaign_id)
        order by e.created_at desc limit v_limit
      ) e
    ),'[]'::jsonb)
  );
end;
$function$;

create or replace function public.dnd_ai_usage(p_campaign_id uuid,p_limit integer)
returns jsonb language sql stable security invoker set search_path=public,private,pg_temp
as $function$ select private.dnd_ai_usage(p_campaign_id,p_limit); $function$;

create or replace function private.dnd_ai_save_evaluation(
  p_campaign_id uuid,p_feature text,p_suite_version text,p_artifact_hash text,p_outcome text,p_report jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,pg_temp
as $function$
declare
  v_tenant uuid;
  v_role text;
  v_run public.dnd_ai_evaluation_runs%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode='42501'; end if;
  v_tenant:=private.dnd_ai_scope_tenant(p_campaign_id);
  if p_campaign_id is not null then
    v_role:=private.dnd_campaign_role(p_campaign_id);
    if v_role is null then raise exception 'Campaign access is required' using errcode='42501'; end if;
  elsif private.nexus_tenant_role(v_tenant) is null then
    raise exception 'Tenant access is required' using errcode='42501';
  end if;
  if nullif(btrim(p_feature),'') is null or nullif(btrim(p_suite_version),'') is null or p_artifact_hash !~ '^[a-f0-9]{64}$'
    or p_outcome not in ('pass','warn','fail') or jsonb_typeof(p_report)<>'object' or octet_length(p_report::text)>200000 then
    raise exception 'Invalid evaluation report' using errcode='22023';
  end if;
  insert into public.dnd_ai_evaluation_runs(tenant_id,campaign_id,user_id,feature,suite_version,artifact_hash,outcome,report)
  values(v_tenant,p_campaign_id,auth.uid(),btrim(p_feature),btrim(p_suite_version),p_artifact_hash,p_outcome,p_report)
  returning * into v_run;
  return jsonb_build_object('id',v_run.id,'campaignId',v_run.campaign_id,'feature',v_run.feature,'suiteVersion',v_run.suite_version,
    'artifactHash',v_run.artifact_hash,'outcome',v_run.outcome,'report',v_run.report,'createdAt',v_run.created_at);
end;
$function$;

create or replace function public.dnd_ai_save_evaluation(
  p_campaign_id uuid,p_feature text,p_suite_version text,p_artifact_hash text,p_outcome text,p_report jsonb
)
returns jsonb language sql security invoker set search_path=public,private,pg_temp
as $function$ select private.dnd_ai_save_evaluation(p_campaign_id,p_feature,p_suite_version,p_artifact_hash,p_outcome,p_report); $function$;

create or replace function private.dnd_ai_evaluations(p_campaign_id uuid,p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path=public,private,pg_temp
as $function$
declare
  v_tenant uuid;
  v_limit integer;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode='42501'; end if;
  v_limit:=greatest(1,least(coalesce(p_limit,100),500));
  v_tenant:=private.dnd_ai_scope_tenant(p_campaign_id);
  if (p_campaign_id is not null and not private.dnd_can_manage_campaign(p_campaign_id))
     or (p_campaign_id is null and not private.dnd_ai_can_manage_tenant(v_tenant)) then
    raise exception 'Management permission is required' using errcode='42501';
  end if;
  return jsonb_build_object('canManage',true,'evaluations',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',r.id,'campaignId',r.campaign_id,'userId',r.user_id,'feature',r.feature,
      'suiteVersion',r.suite_version,'artifactHash',r.artifact_hash,'outcome',r.outcome,
      'report',r.report,'createdAt',r.created_at
    ) order by r.created_at desc)
    from (select * from public.dnd_ai_evaluation_runs r where r.tenant_id=v_tenant and (p_campaign_id is null or r.campaign_id=p_campaign_id) order by r.created_at desc limit v_limit) r
  ),'[]'::jsonb));
end;
$function$;

create or replace function public.dnd_ai_evaluations(p_campaign_id uuid,p_limit integer)
returns jsonb language sql stable security invoker set search_path=public,private,pg_temp
as $function$ select private.dnd_ai_evaluations(p_campaign_id,p_limit); $function$;

commit;
