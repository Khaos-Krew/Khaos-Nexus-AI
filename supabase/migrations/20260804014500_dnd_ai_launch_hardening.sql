begin;

create or replace function private.dnd_ai_scope_tenant_explicit(
  p_campaign_id uuid,
  p_tenant_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_campaign_tenant uuid;
  v_role text;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  if p_campaign_id is not null then
    v_role := private.dnd_campaign_role(p_campaign_id);
    if v_role is null then
      raise exception 'Campaign not found or access denied' using errcode = '42501';
    end if;
    select tenant_id into v_campaign_tenant
    from public.dnd_campaigns
    where id = p_campaign_id;
    if v_campaign_tenant is null then
      raise exception 'Campaign tenant is unavailable' using errcode = 'P0002';
    end if;
    if p_tenant_id is not null and p_tenant_id <> v_campaign_tenant then
      raise exception 'Tenant and campaign do not match' using errcode = '22023';
    end if;
    return v_campaign_tenant;
  end if;

  if p_tenant_id is null then
    raise exception 'An explicit tenant is required for stateless generation' using errcode = '22023';
  end if;
  if private.nexus_tenant_role(p_tenant_id) is null then
    raise exception 'Tenant not found or access denied' using errcode = '42501';
  end if;
  return p_tenant_id;
end;
$function$;

create or replace function private.dnd_ai_generation_policy_v2(
  p_campaign_id uuid,
  p_tenant_id uuid,
  p_feature text,
  p_provider text,
  p_model text,
  p_prompt_id text,
  p_prompt_version text,
  p_prompt_hash text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_tenant uuid;
  v_policy public.dnd_ai_model_policies%rowtype;
begin
  if nullif(btrim(p_feature), '') is null or nullif(btrim(p_provider), '') is null
     or nullif(btrim(p_model), '') is null or nullif(btrim(p_prompt_id), '') is null
     or nullif(btrim(p_prompt_version), '') is null or p_prompt_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A valid generation policy request is required' using errcode = '22023';
  end if;

  v_tenant := private.dnd_ai_scope_tenant_explicit(p_campaign_id, p_tenant_id);
  select * into v_policy
  from public.dnd_ai_model_policies p
  where p.active
    and p.feature = p_feature
    and p.provider = p_provider
    and p.model_pattern in (p_model, '*')
    and p.prompt_id = p_prompt_id
    and p.prompt_version = p_prompt_version
    and p.prompt_hash = p_prompt_hash
    and (p.tenant_id is null or p.tenant_id = v_tenant)
  order by (p.tenant_id is not null) desc, (p.model_pattern = p_model) desc, p.updated_at desc
  limit 1;

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'model_policy_not_found', 'policy', null);
  end if;
  return jsonb_build_object(
    'allowed', true,
    'reason', null,
    'policy', jsonb_build_object(
      'id', v_policy.id,
      'tenantId', v_policy.tenant_id,
      'feature', v_policy.feature,
      'provider', v_policy.provider,
      'modelPattern', v_policy.model_pattern,
      'promptId', v_policy.prompt_id,
      'promptVersion', v_policy.prompt_version,
      'promptHash', v_policy.prompt_hash,
      'policyVersion', v_policy.policy_version,
      'maxInputTokens', v_policy.max_input_tokens,
      'maxOutputTokens', v_policy.max_output_tokens,
      'inputCostMicrosPerMillion', v_policy.input_cost_micros_per_million,
      'outputCostMicrosPerMillion', v_policy.output_cost_micros_per_million,
      'active', v_policy.active
    )
  );
end;
$function$;

create or replace function private.dnd_ai_reserve_generation_core(
  p_request_id uuid,
  p_tenant_id uuid,
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
  v_matching_budgets integer := 0;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  if p_request_id is null or nullif(btrim(p_feature),'') is null or nullif(btrim(p_provider),'') is null
    or nullif(btrim(p_model),'') is null or nullif(btrim(p_prompt_id),'') is null
    or nullif(btrim(p_prompt_version),'') is null or p_prompt_hash !~ '^[a-f0-9]{64}$'
    or p_input_hash !~ '^[a-f0-9]{64}$' or p_estimated_input_tokens < 0 or p_reserved_output_tokens < 0 then
    raise exception 'Invalid generation reservation' using errcode = '22023';
  end if;

  select * into v_existing from public.dnd_ai_usage_events
  where request_id = p_request_id and user_id = auth.uid();
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
        ) from public.dnd_ai_model_policies p where p.id = v_existing.policy_id
      ) end
    );
  end if;

  v_tenant := private.dnd_ai_scope_tenant_explicit(p_campaign_id, p_tenant_id);
  v_policy_result := private.dnd_ai_generation_policy_v2(
    p_campaign_id, v_tenant, p_feature, p_provider, p_model,
    p_prompt_id, p_prompt_version, p_prompt_hash
  );
  if not coalesce((v_policy_result->>'allowed')::boolean,false) then
    v_event := private.dnd_ai_insert_blocked_usage(
      p_request_id,v_tenant,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash,p_input_hash,
      coalesce(v_policy_result->>'reason','model_policy_not_found'), null
    );
    return jsonb_build_object('allowed',false,'reason',v_event.block_reason,'event',private.dnd_ai_usage_event_json(v_event),'policy',null);
  end if;

  select * into v_policy from public.dnd_ai_model_policies
  where id = (v_policy_result->'policy'->>'id')::uuid;
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

  select count(*) into v_matching_budgets
  from public.dnd_ai_budgets b
  where b.active and b.tenant_id = v_tenant
    and (b.campaign_id is null or b.campaign_id = p_campaign_id)
    and (b.user_id is null or b.user_id = auth.uid())
    and (b.feature is null or b.feature = p_feature);

  if p_provider = 'openai' and v_matching_budgets = 0 then
    v_event := private.dnd_ai_insert_blocked_usage(
      p_request_id,v_tenant,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,p_prompt_version,p_prompt_hash,p_input_hash,
      'budget_required',v_policy
    );
    return jsonb_build_object('allowed',false,'reason','budget_required','event',private.dnd_ai_usage_event_json(v_event),'policy',v_policy_result->'policy');
  end if;

  for v_budget in
    select * from public.dnd_ai_budgets b
    where b.active and b.tenant_id = v_tenant
      and (b.campaign_id is null or b.campaign_id = p_campaign_id)
      and (b.user_id is null or b.user_id = auth.uid())
      and (b.feature is null or b.feature = p_feature)
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

create or replace function private.dnd_ai_reserve_generation_v2(
  p_request_id uuid,p_tenant_id uuid,p_campaign_id uuid,p_feature text,p_provider text,p_model text,p_prompt_id text,
  p_prompt_version text,p_prompt_hash text,p_estimated_input_tokens bigint,p_reserved_output_tokens bigint,p_input_hash text
)
returns jsonb
language sql
security definer
set search_path=public,private,pg_temp
as $function$
  select private.dnd_ai_reserve_generation_core(
    p_request_id,p_tenant_id,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,
    p_prompt_version,p_prompt_hash,p_estimated_input_tokens,p_reserved_output_tokens,p_input_hash
  );
$function$;

create or replace function public.dnd_ai_reserve_generation_v2(
  p_request_id uuid,p_tenant_id uuid,p_campaign_id uuid,p_feature text,p_provider text,p_model text,p_prompt_id text,
  p_prompt_version text,p_prompt_hash text,p_estimated_input_tokens bigint,p_reserved_output_tokens bigint,p_input_hash text
)
returns jsonb
language sql
security invoker
set search_path=public,private,pg_temp
as $function$
  select private.dnd_ai_reserve_generation_v2(
    p_request_id,p_tenant_id,p_campaign_id,p_feature,p_provider,p_model,p_prompt_id,
    p_prompt_version,p_prompt_hash,p_estimated_input_tokens,p_reserved_output_tokens,p_input_hash
  );
$function$;

update public.dnd_ai_model_policies
set active = false, updated_at = now()
where tenant_id is null and provider = 'openai' and model_pattern = '*' and active;

insert into public.dnd_ai_model_policies(
  tenant_id,feature,provider,model_pattern,prompt_id,prompt_version,prompt_hash,policy_version,
  max_input_tokens,max_output_tokens,input_cost_micros_per_million,output_cost_micros_per_million,active,created_by
)
select
  null,p.feature,'openai','gpt-5-mini',p.prompt_id,p.prompt_version,p.prompt_hash,'launch-1',
  p.max_input_tokens,p.max_output_tokens,250000,2000000,true,null
from public.dnd_ai_model_policies p
where p.tenant_id is null and p.provider='openai' and p.model_pattern='*'
  and not exists (
    select 1 from public.dnd_ai_model_policies existing
    where existing.tenant_id is null and existing.feature=p.feature and existing.provider='openai'
      and existing.model_pattern='gpt-5-mini' and existing.prompt_id=p.prompt_id
      and existing.prompt_version=p.prompt_version and existing.prompt_hash=p.prompt_hash
      and existing.policy_version='launch-1'
  );

revoke all on function public.dnd_ai_reserve_generation_v2(uuid,uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) from public, anon;
grant execute on function public.dnd_ai_reserve_generation_v2(uuid,uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) to authenticated;

commit;
