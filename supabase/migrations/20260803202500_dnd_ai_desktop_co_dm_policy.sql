begin;
insert into public.dnd_ai_model_policies(
  tenant_id,feature,provider,model_pattern,prompt_id,prompt_version,prompt_hash,policy_version,
  max_input_tokens,max_output_tokens,input_cost_micros_per_million,output_cost_micros_per_million,active,created_by
)
select null,'co_dm.draft',v.provider,v.model_pattern,'dnd-co-dm-draft','1',
  'fce64509f922302feafadd7a74e8cd741fa52376c9bee3eefce1770fbc9c110a','baseline-1',
  128000,8000,0,0,true,null
from (values ('mock','deterministic-local'),('openai','*')) as v(provider,model_pattern)
on conflict do nothing;
commit;
