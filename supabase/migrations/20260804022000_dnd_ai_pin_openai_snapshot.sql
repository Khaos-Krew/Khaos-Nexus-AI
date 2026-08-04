begin;

update public.dnd_ai_model_policies
set active = false, updated_at = now()
where tenant_id is null
  and provider = 'openai'
  and active
  and model_pattern <> 'gpt-5-mini-2025-08-07';

insert into public.dnd_ai_model_policies(
  tenant_id,
  feature,
  provider,
  model_pattern,
  prompt_id,
  prompt_version,
  prompt_hash,
  policy_version,
  max_input_tokens,
  max_output_tokens,
  input_cost_micros_per_million,
  output_cost_micros_per_million,
  active,
  created_by
)
select
  null,
  source.feature,
  'openai',
  'gpt-5-mini-2025-08-07',
  source.prompt_id,
  source.prompt_version,
  source.prompt_hash,
  'launch-2',
  source.max_input_tokens,
  source.max_output_tokens,
  250000,
  2000000,
  true,
  null
from public.dnd_ai_model_policies source
where source.tenant_id is null
  and source.provider = 'openai'
  and source.model_pattern = 'gpt-5-mini'
  and source.policy_version = 'launch-1'
  and not exists (
    select 1
    from public.dnd_ai_model_policies existing
    where existing.tenant_id is null
      and existing.feature = source.feature
      and existing.provider = 'openai'
      and existing.model_pattern = 'gpt-5-mini-2025-08-07'
      and existing.prompt_id = source.prompt_id
      and existing.prompt_version = source.prompt_version
      and existing.prompt_hash = source.prompt_hash
      and existing.policy_version = 'launch-2'
  );

update public.dnd_ai_model_policies
set active = true, updated_at = now()
where tenant_id is null
  and provider = 'openai'
  and model_pattern = 'gpt-5-mini-2025-08-07'
  and policy_version = 'launch-2';

commit;
