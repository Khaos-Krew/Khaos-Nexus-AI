begin;

create or replace function private.dnd_ai_default_tenant()
returns uuid
language sql
stable
security definer
set search_path = public, private, pg_temp
as $function$
  select coalesce(
    (select t.id from public.nexus_tenants t where t.owner_id = auth.uid() order by t.created_at limit 1),
    (select m.tenant_id from public.nexus_tenant_members m where m.user_id = auth.uid() order by m.created_at limit 1)
  );
$function$;

create or replace function private.dnd_ai_scope_tenant(p_campaign_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_tenant uuid;
begin
  if p_campaign_id is not null then
    if private.dnd_campaign_role(p_campaign_id) is null then
      raise exception 'Campaign not found or access denied' using errcode = '42501';
    end if;
    select tenant_id into v_tenant from public.dnd_campaigns where id = p_campaign_id;
    return v_tenant;
  end if;
  return private.dnd_ai_default_tenant();
end;
$function$;

create or replace function private.dnd_ai_can_manage_tenant(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, private, pg_temp
as $function$
  select coalesce(private.nexus_tenant_role(p_tenant_id) in ('owner','admin'), false);
$function$;

create or replace function private.dnd_ai_generation_policy(
  p_campaign_id uuid,
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
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  if nullif(btrim(p_feature), '') is null or nullif(btrim(p_provider), '') is null
     or nullif(btrim(p_model), '') is null or nullif(btrim(p_prompt_id), '') is null
     or nullif(btrim(p_prompt_version), '') is null or p_prompt_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'A valid generation policy request is required' using errcode = '22023';
  end if;
  v_tenant := private.dnd_ai_scope_tenant(p_campaign_id);

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

create or replace function public.dnd_ai_generation_policy(
  p_campaign_id uuid,
  p_feature text,
  p_provider text,
  p_model text,
  p_prompt_id text,
  p_prompt_version text,
  p_prompt_hash text
)
returns jsonb
language sql
stable
security invoker
set search_path = public, private, pg_temp
as $function$
  select private.dnd_ai_generation_policy(p_campaign_id, p_feature, p_provider, p_model, p_prompt_id, p_prompt_version, p_prompt_hash);
$function$;

create or replace function private.dnd_ai_budgets(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_tenant uuid;
  v_can_manage boolean;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  v_tenant := private.dnd_ai_scope_tenant(p_campaign_id);
  v_can_manage := case when p_campaign_id is not null then private.dnd_can_manage_campaign(p_campaign_id) else private.dnd_ai_can_manage_tenant(v_tenant) end;
  if not v_can_manage then raise exception 'Management permission is required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'canManage', true,
    'tenantId', v_tenant,
    'budgets', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', b.id, 'tenantId', b.tenant_id, 'campaignId', b.campaign_id, 'userId', b.user_id,
        'feature', b.feature, 'period', b.period, 'requestLimit', b.request_limit,
        'inputTokenLimit', b.input_token_limit, 'outputTokenLimit', b.output_token_limit,
        'costLimitMicros', b.cost_limit_micros, 'active', b.active,
        'createdAt', b.created_at, 'updatedAt', b.updated_at
      ) order by b.updated_at desc)
      from public.dnd_ai_budgets b
      where b.tenant_id = v_tenant and (p_campaign_id is null or b.campaign_id is null or b.campaign_id = p_campaign_id)
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.dnd_ai_budgets(p_campaign_id uuid)
returns jsonb language sql stable security invoker set search_path = public, private, pg_temp
as $function$ select private.dnd_ai_budgets(p_campaign_id); $function$;

create or replace function private.dnd_ai_upsert_budget(
  p_budget_id uuid,
  p_tenant_id uuid,
  p_campaign_id uuid,
  p_user_id uuid,
  p_feature text,
  p_period text,
  p_request_limit bigint,
  p_input_token_limit bigint,
  p_output_token_limit bigint,
  p_cost_limit_micros bigint,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_tenant uuid;
  v_budget public.dnd_ai_budgets%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  if p_period not in ('daily','monthly') then raise exception 'Invalid budget period' using errcode = '22023'; end if;
  if p_request_limit is null and p_input_token_limit is null and p_output_token_limit is null and p_cost_limit_micros is null then
    raise exception 'At least one budget limit is required' using errcode = '22023';
  end if;
  if least(coalesce(p_request_limit,0), coalesce(p_input_token_limit,0), coalesce(p_output_token_limit,0), coalesce(p_cost_limit_micros,0)) < 0 then
    raise exception 'Budget limits cannot be negative' using errcode = '22023';
  end if;

  if p_campaign_id is not null then
    select tenant_id into v_tenant from public.dnd_campaigns where id = p_campaign_id;
    if v_tenant is null or not private.dnd_can_manage_campaign(p_campaign_id) then
      raise exception 'Campaign management permission is required' using errcode = '42501';
    end if;
  else
    v_tenant := coalesce(p_tenant_id, private.dnd_ai_default_tenant());
    if v_tenant is null or not private.dnd_ai_can_manage_tenant(v_tenant) then
      raise exception 'Tenant administration permission is required' using errcode = '42501';
    end if;
  end if;
  if p_tenant_id is not null and p_tenant_id <> v_tenant then raise exception 'Budget tenant mismatch' using errcode = '22023'; end if;

  if p_budget_id is null then
    insert into public.dnd_ai_budgets(
      tenant_id, campaign_id, user_id, feature, period, request_limit, input_token_limit,
      output_token_limit, cost_limit_micros, active, created_by
    ) values (
      v_tenant, p_campaign_id, p_user_id, nullif(btrim(p_feature), ''), p_period,
      p_request_limit, p_input_token_limit, p_output_token_limit, p_cost_limit_micros,
      coalesce(p_active, true), auth.uid()
    ) returning * into v_budget;
  else
    update public.dnd_ai_budgets b set
      user_id = p_user_id, feature = nullif(btrim(p_feature), ''), period = p_period,
      request_limit = p_request_limit, input_token_limit = p_input_token_limit,
      output_token_limit = p_output_token_limit, cost_limit_micros = p_cost_limit_micros,
      active = coalesce(p_active, true), updated_at = now()
    where b.id = p_budget_id and b.tenant_id = v_tenant
      and (p_campaign_id is null or b.campaign_id = p_campaign_id)
    returning * into v_budget;
    if not found then raise exception 'Budget not found' using errcode = 'P0002'; end if;
  end if;

  insert into public.dnd_audit_log(tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata)
  values (v_tenant, p_campaign_id, auth.uid(), 'ai.budget.upserted', 'ai_budget', v_budget.id::text,
    jsonb_build_object('period', v_budget.period, 'feature', v_budget.feature, 'active', v_budget.active));

  return to_jsonb(v_budget) - 'created_by';
end;
$function$;

create or replace function public.dnd_ai_upsert_budget(
  p_budget_id uuid,
  p_tenant_id uuid,
  p_campaign_id uuid,
  p_user_id uuid,
  p_feature text,
  p_period text,
  p_request_limit bigint,
  p_input_token_limit bigint,
  p_output_token_limit bigint,
  p_cost_limit_micros bigint,
  p_active boolean
)
returns jsonb language sql security invoker set search_path = public, private, pg_temp
as $function$ select private.dnd_ai_upsert_budget(p_budget_id,p_tenant_id,p_campaign_id,p_user_id,p_feature,p_period,p_request_limit,p_input_token_limit,p_output_token_limit,p_cost_limit_micros,p_active); $function$;

create or replace function private.dnd_ai_model_policies(p_campaign_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_tenant uuid;
  v_can_manage boolean;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  v_tenant := private.dnd_ai_scope_tenant(p_campaign_id);
  v_can_manage := case when p_campaign_id is not null then private.dnd_can_manage_campaign(p_campaign_id) else private.dnd_ai_can_manage_tenant(v_tenant) end;
  if not v_can_manage then raise exception 'Management permission is required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'canManage', true,
    'tenantId', v_tenant,
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'tenantId', p.tenant_id, 'feature', p.feature, 'provider', p.provider,
        'modelPattern', p.model_pattern, 'promptId', p.prompt_id, 'promptVersion', p.prompt_version,
        'promptHash', p.prompt_hash, 'policyVersion', p.policy_version,
        'maxInputTokens', p.max_input_tokens, 'maxOutputTokens', p.max_output_tokens,
        'inputCostMicrosPerMillion', p.input_cost_micros_per_million,
        'outputCostMicrosPerMillion', p.output_cost_micros_per_million,
        'active', p.active, 'createdAt', p.created_at, 'updatedAt', p.updated_at
      ) order by (p.tenant_id is not null) desc, p.feature, p.provider, p.updated_at desc)
      from public.dnd_ai_model_policies p where p.tenant_id is null or p.tenant_id = v_tenant
    ), '[]'::jsonb)
  );
end;
$function$;

create or replace function public.dnd_ai_model_policies(p_campaign_id uuid)
returns jsonb language sql stable security invoker set search_path = public, private, pg_temp
as $function$ select private.dnd_ai_model_policies(p_campaign_id); $function$;

create or replace function private.dnd_ai_upsert_model_policy(
  p_policy_id uuid,
  p_campaign_id uuid,
  p_feature text,
  p_provider text,
  p_model_pattern text,
  p_prompt_id text,
  p_prompt_version text,
  p_prompt_hash text,
  p_policy_version text,
  p_max_input_tokens integer,
  p_max_output_tokens integer,
  p_input_cost_micros_per_million bigint,
  p_output_cost_micros_per_million bigint,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $function$
declare
  v_tenant uuid;
  v_policy public.dnd_ai_model_policies%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication is required' using errcode = '42501'; end if;
  v_tenant := private.dnd_ai_scope_tenant(p_campaign_id);
  if v_tenant is null or not private.dnd_ai_can_manage_tenant(v_tenant) then
    raise exception 'Tenant administration permission is required' using errcode = '42501';
  end if;
  if nullif(btrim(p_feature),'') is null or nullif(btrim(p_provider),'') is null or nullif(btrim(p_model_pattern),'') is null
    or nullif(btrim(p_prompt_id),'') is null or nullif(btrim(p_prompt_version),'') is null or nullif(btrim(p_policy_version),'') is null
    or p_prompt_hash !~ '^[a-f0-9]{64}$' or p_max_input_tokens <= 0 or p_max_output_tokens <= 0
    or p_input_cost_micros_per_million < 0 or p_output_cost_micros_per_million < 0 then
    raise exception 'Invalid model policy' using errcode = '22023';
  end if;

  if p_policy_id is null then
    insert into public.dnd_ai_model_policies(
      tenant_id, feature, provider, model_pattern, prompt_id, prompt_version, prompt_hash,
      policy_version, max_input_tokens, max_output_tokens, input_cost_micros_per_million,
      output_cost_micros_per_million, active, created_by
    ) values (
      v_tenant, btrim(p_feature), btrim(p_provider), btrim(p_model_pattern), btrim(p_prompt_id),
      btrim(p_prompt_version), p_prompt_hash, btrim(p_policy_version), p_max_input_tokens,
      p_max_output_tokens, p_input_cost_micros_per_million, p_output_cost_micros_per_million,
      coalesce(p_active,true), auth.uid()
    ) returning * into v_policy;
  else
    update public.dnd_ai_model_policies p set
      feature=btrim(p_feature), provider=btrim(p_provider), model_pattern=btrim(p_model_pattern),
      prompt_id=btrim(p_prompt_id), prompt_version=btrim(p_prompt_version), prompt_hash=p_prompt_hash,
      policy_version=btrim(p_policy_version), max_input_tokens=p_max_input_tokens,
      max_output_tokens=p_max_output_tokens, input_cost_micros_per_million=p_input_cost_micros_per_million,
      output_cost_micros_per_million=p_output_cost_micros_per_million,
      active=coalesce(p_active,true), updated_at=now()
    where p.id=p_policy_id and p.tenant_id=v_tenant returning * into v_policy;
    if not found then raise exception 'Model policy not found' using errcode = 'P0002'; end if;
  end if;

  insert into public.dnd_audit_log(tenant_id, campaign_id, actor_user_id, action, target_type, target_id, metadata)
  values (v_tenant, p_campaign_id, auth.uid(), 'ai.model_policy.upserted', 'ai_model_policy', v_policy.id::text,
    jsonb_build_object('feature',v_policy.feature,'provider',v_policy.provider,'modelPattern',v_policy.model_pattern,'active',v_policy.active));
  return to_jsonb(v_policy) - 'created_by';
end;
$function$;

create or replace function public.dnd_ai_upsert_model_policy(
  p_policy_id uuid,
  p_campaign_id uuid,
  p_feature text,
  p_provider text,
  p_model_pattern text,
  p_prompt_id text,
  p_prompt_version text,
  p_prompt_hash text,
  p_policy_version text,
  p_max_input_tokens integer,
  p_max_output_tokens integer,
  p_input_cost_micros_per_million bigint,
  p_output_cost_micros_per_million bigint,
  p_active boolean
)
returns jsonb language sql security invoker set search_path = public, private, pg_temp
as $function$ select private.dnd_ai_upsert_model_policy(p_policy_id,p_campaign_id,p_feature,p_provider,p_model_pattern,p_prompt_id,p_prompt_version,p_prompt_hash,p_policy_version,p_max_input_tokens,p_max_output_tokens,p_input_cost_micros_per_million,p_output_cost_micros_per_million,p_active); $function$;

commit;
