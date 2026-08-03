begin;

create or replace function private.dnd_ai_usage_event_json(p_event public.dnd_ai_usage_events)
returns jsonb
language sql
immutable
set search_path = public, private, pg_temp
as $function$
  select jsonb_build_object(
    'id', p_event.id,
    'requestId', p_event.request_id,
    'tenantId', p_event.tenant_id,
    'campaignId', p_event.campaign_id,
    'userId', p_event.user_id,
    'feature', p_event.feature,
    'provider', p_event.provider,
    'model', p_event.model,
    'promptId', p_event.prompt_id,
    'promptVersion', p_event.prompt_version,
    'promptHash', p_event.prompt_hash,
    'policyVersion', p_event.policy_version,
    'inputHash', p_event.input_hash,
    'outputHash', p_event.output_hash,
    'providerRequestId', p_event.provider_request_id,
    'status', p_event.status,
    'blockReason', p_event.block_reason,
    'errorCode', p_event.error_code,
    'estimatedInputTokens', p_event.estimated_input_tokens,
    'reservedOutputTokens', p_event.reserved_output_tokens,
    'inputTokens', p_event.input_tokens,
    'outputTokens', p_event.output_tokens,
    'cachedInputTokens', p_event.cached_input_tokens,
    'reasoningTokens', p_event.reasoning_tokens,
    'reservedCostMicros', p_event.reserved_cost_micros,
    'costMicros', p_event.cost_micros,
    'latencyMs', p_event.latency_ms,
    'evaluationSummary', p_event.evaluation_summary,
    'createdAt', p_event.created_at,
    'finalizedAt', p_event.finalized_at
  );
$function$;

create or replace function private.dnd_ai_insert_blocked_usage(
  p_request_id uuid,
  p_tenant_id uuid,
  p_campaign_id uuid,
  p_feature text,
  p_provider text,
  p_model text,
  p_prompt_id text,
  p_prompt_version text,
  p_prompt_hash text,
  p_input_hash text,
  p_reason text,
  p_policy public.dnd_ai_model_policies
)
returns public.dnd_ai_usage_events
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_event public.dnd_ai_usage_events%rowtype;
begin
  insert into public.dnd_ai_usage_events(
    request_id, tenant_id, campaign_id, user_id, policy_id, feature, provider, model,
    prompt_id, prompt_version, prompt_hash, policy_version, input_hash, status, block_reason,
    input_cost_micros_per_million, output_cost_micros_per_million
  ) values (
    p_request_id, p_tenant_id, p_campaign_id, auth.uid(), p_policy.id, p_feature, p_provider, p_model,
    p_prompt_id, p_prompt_version, p_prompt_hash, p_policy.policy_version, p_input_hash, 'blocked', left(p_reason,120),
    coalesce(p_policy.input_cost_micros_per_million,0), coalesce(p_policy.output_cost_micros_per_million,0)
  ) returning * into v_event;
  return v_event;
exception when unique_violation then
  select * into v_event from public.dnd_ai_usage_events where request_id=p_request_id and user_id=auth.uid();
  return v_event;
end;
$function$;

create or replace function private.dnd_ai_reserve_generation(
  p_request_id uuid,
  p_campaign_id uuid,
  p_feature text,
  p_provider text,
  p_model text,
  p_prompt_id text,
  p_prompt_version text,
  p_prompt_hash text,
  p_estimated_input_tokens bigint,
  p_reserved_output_tokens bigint,
  p_input_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_existing public.dnd_ai_usage_events%rowtype;
  v_policy_result jsonb;
  v_policy public.dnd_ai_model_policies%rowtype;
  v_tenant uuid;
  v_reserved_cost bigint := 0;
  v_budget public.dnd_ai_budgets%rowtype;
  v_start timestamptz;
  v_requests bigint;
  v_input bigint;
  v_output bigint;
  v_cost bigint;
  v_reason text;
  v_event public.dnd_ai_usage_events%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  if p_request_id is null or nullif(btrim(p_feature),'') is null or nullif(btrim(p_provider),'') is null
    or nullif(btrim(p_model),'') is null or nullif(btrim(p_prompt_id),'') is null
    or nullif(btrim(p_prompt_version),'') is null or p_prompt_hash !~ '^[a-f0-9]{64}$'
    or p_input_hash !~ '^[a-f0-9]{64}$' or p_estimated_input_tokens < 0 or p_reserved_output_tokens < 0 then
    raise exception 'Invalid generation reservation' using errcode = '22023';
  end if;

  select * into v_existing from public.dnd_ai_usage_events
  where request_id=p_request_id and user_id=auth.uid();
  if found then
    return jsonb_build_object(
      'allowed', v_existing.status <> 'blocked',
      'reason', v_existing.block_reason,
      'event', private.dnd_ai_usage_event_json(v_existing),
      'policy', case when v_existing.policy_id is null then null else (
        select jsonb_build_object(
          'id',p.id,'feature',p.feature,'provider',p.provider,'modelPattern',p.model_pattern,
          'promptId',p.prompt_id,'promptVersion',p.prompt_version,'promptHash',p.prompt_hash,
          'policyVersion',p.policy_version,'maxInputTokens',p.max_input_tokens,'maxOutputTokens',p.max_output_tokens,
          'inputCostMicrosPerMillion',p.input_cost_micros_per_million,
          'outputCostMicrosPerMillion',p.output_cost_micros_per_million,'active',p.active
        ) from public.dnd_ai_model_policies p where p.id=v_existing.policy_id
      ) end
    );
  end if;

  v_tenant := private.dnd_ai_scope_tenant(p_campaign_id);
  v_policy_result := private.dnd_ai_generation_policy(p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash);
  if not coalesce((v_policy_result->>'allowed')::boolean,false) then
    v_event := private.dnd_ai_insert_blocked_usage(
      p_request_id,v_tenant,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash,p_input_hash,
      coalesce(v_policy_result->>'reason','model_policy_not_found'), null
    );
    return jsonb_build_object('allowed',false,'reason',v_event.block_reason,'event',private.dnd_ai_usage_event_json(v_event),'policy',null);
  end if;

  select * into v_policy from public.dnd_ai_model_policies where id=(v_policy_result->'policy'->>'id')::uuid;
  if p_estimated_input_tokens > v_policy.max_input_tokens then
    v_event := private.dnd_ai_insert_blocked_usage(p_request_id,v_tenant,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash,p_input_hash,'max_input_tokens',v_policy);
    return jsonb_build_object('allowed',false,'reason','max_input_tokens','event',private.dnd_ai_usage_event_json(v_event),'policy',v_policy_result->'policy');
  end if;
  if p_reserved_output_tokens > v_policy.max_output_tokens then
    v_event := private.dnd_ai_insert_blocked_usage(p_request_id,v_tenant,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash,p_input_hash,'max_output_tokens',v_policy);
    return jsonb_build_object('allowed',false,'reason','max_output_tokens','event',private.dnd_ai_usage_event_json(v_event),'policy',v_policy_result->'policy');
  end if;

  v_reserved_cost := ceil((
    p_estimated_input_tokens::numeric * v_policy.input_cost_micros_per_million
    + p_reserved_output_tokens::numeric * v_policy.output_cost_micros_per_million
  ) / 1000000)::bigint;

  for v_budget in
    select * from public.dnd_ai_budgets b
    where b.active and b.tenant_id=v_tenant
      and (b.campaign_id is null or b.campaign_id=p_campaign_id)
      and (b.user_id is null or b.user_id=auth.uid())
      and (b.feature is null or b.feature=p_feature)
    order by b.id
    for update
  loop
    v_start := case when v_budget.period='daily' then date_trunc('day',now()) else date_trunc('month',now()) end;
    select count(*),
      coalesce(sum(case when e.status='reserved' then e.estimated_input_tokens else e.input_tokens end),0),
      coalesce(sum(case when e.status='reserved' then e.reserved_output_tokens else e.output_tokens end),0),
      coalesce(sum(case when e.status='reserved' then e.reserved_cost_micros else e.cost_micros end),0)
    into v_requests,v_input,v_output,v_cost
    from public.dnd_ai_usage_events e
    where e.created_at>=v_start and e.status<>'blocked' and e.tenant_id=v_tenant
      and (v_budget.campaign_id is null or e.campaign_id=v_budget.campaign_id)
      and (v_budget.user_id is null or e.user_id=v_budget.user_id)
      and (v_budget.feature is null or e.feature=v_budget.feature);

    v_reason := null;
    if v_budget.request_limit is not null and v_requests+1>v_budget.request_limit then v_reason:='request_limit';
    elsif v_budget.input_token_limit is not null and v_input+p_estimated_input_tokens>v_budget.input_token_limit then v_reason:='input_token_limit';
    elsif v_budget.output_token_limit is not null and v_output+p_reserved_output_tokens>v_budget.output_token_limit then v_reason:='output_token_limit';
    elsif v_budget.cost_limit_micros is not null and v_cost+v_reserved_cost>v_budget.cost_limit_micros then v_reason:='cost_limit';
    end if;
    if v_reason is not null then
      v_event := private.dnd_ai_insert_blocked_usage(p_request_id,v_tenant,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash,p_input_hash,v_reason,v_policy);
      return jsonb_build_object('allowed',false,'reason',v_reason,'budgetId',v_budget.id,'event',private.dnd_ai_usage_event_json(v_event),'policy',v_policy_result->'policy');
    end if;
  end loop;

  begin
    insert into public.dnd_ai_usage_events(
      request_id,tenant_id,campaign_id,user_id,policy_id,feature,provider,model,prompt_id,prompt_version,prompt_hash,
      policy_version,input_hash,status,estimated_input_tokens,reserved_output_tokens,
      input_cost_micros_per_million,output_cost_micros_per_million,reserved_cost_micros
    ) values (
      p_request_id,v_tenant,p_campaign_id,auth.uid(),v_policy.id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash,
      v_policy.policy_version,p_input_hash,'reserved',p_estimated_input_tokens,p_reserved_output_tokens,
      v_policy.input_cost_micros_per_million,v_policy.output_cost_micros_per_million,v_reserved_cost
    ) returning * into v_event;
  exception when unique_violation then
    select * into v_event from public.dnd_ai_usage_events where request_id=p_request_id and user_id=auth.uid();
  end;

  return jsonb_build_object('allowed',v_event.status<>'blocked','reason',v_event.block_reason,'event',private.dnd_ai_usage_event_json(v_event),'policy',v_policy_result->'policy');
end;
$function$;

create or replace function public.dnd_ai_reserve_generation(
  p_request_id uuid,p_campaign_id uuid,p_feature text,p_provider text,p_model text,p_prompt_id text,
  p_prompt_version text,p_prompt_hash text,p_estimated_input_tokens bigint,p_reserved_output_tokens bigint,p_input_hash text
)
returns jsonb language sql security invoker set search_path=public,private,pg_temp
as $function$ select private.dnd_ai_reserve_generation(p_request_id,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash,p_estimated_input_tokens,p_reserved_output_tokens,p_input_hash); $function$;

create or replace function private.dnd_ai_finalize_generation(
  p_request_id uuid,
  p_status text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_cached_input_tokens bigint,
  p_reasoning_tokens bigint,
  p_latency_ms integer,
  p_output_hash text,
  p_provider_request_id text,
  p_error_code text,
  p_evaluation_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=public,private,pg_temp
as $function$
declare
  v_event public.dnd_ai_usage_events%rowtype;
  v_cost bigint;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode='42501'; end if;
  if p_status not in ('succeeded','failed') or least(p_input_tokens,p_output_tokens,p_cached_input_tokens,p_reasoning_tokens,p_latency_ms) < 0
    or (p_output_hash is not null and p_output_hash !~ '^[a-f0-9]{64}$')
    or octet_length(coalesce(p_evaluation_summary,'{}'::jsonb)::text)>200000 then
    raise exception 'Invalid generation finalization' using errcode='22023';
  end if;
  select * into v_event from public.dnd_ai_usage_events
  where request_id=p_request_id and user_id=auth.uid() for update;
  if not found then raise exception 'Usage reservation not found' using errcode='P0002'; end if;
  if v_event.status in ('succeeded','failed','blocked') then return private.dnd_ai_usage_event_json(v_event); end if;

  v_cost := ceil((
    p_input_tokens::numeric*v_event.input_cost_micros_per_million
    + p_output_tokens::numeric*v_event.output_cost_micros_per_million
  )/1000000)::bigint;

  update public.dnd_ai_usage_events set
    status=p_status,input_tokens=p_input_tokens,output_tokens=p_output_tokens,
    cached_input_tokens=p_cached_input_tokens,reasoning_tokens=p_reasoning_tokens,
    latency_ms=p_latency_ms,output_hash=p_output_hash,
    provider_request_id=left(coalesce(p_provider_request_id,''),200),
    error_code=left(nullif(btrim(p_error_code),''),120),
    evaluation_summary=coalesce(p_evaluation_summary,'{}'::jsonb),cost_micros=v_cost,finalized_at=now()
  where id=v_event.id returning * into v_event;
  return private.dnd_ai_usage_event_json(v_event);
end;
$function$;

create or replace function public.dnd_ai_finalize_generation(
  p_request_id uuid,p_status text,p_input_tokens bigint,p_output_tokens bigint,p_cached_input_tokens bigint,
  p_reasoning_tokens bigint,p_latency_ms integer,p_output_hash text,p_provider_request_id text,p_error_code text,p_evaluation_summary jsonb
)
returns jsonb language sql security invoker set search_path=public,private,pg_temp
as $function$ select private.dnd_ai_finalize_generation(p_request_id,p_status,p_input_tokens,p_output_tokens,p_cached_input_tokens,p_reasoning_tokens,p_latency_ms,p_output_hash,p_provider_request_id,p_error_code,p_evaluation_summary); $function$;

commit;
