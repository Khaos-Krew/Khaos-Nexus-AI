begin;

insert into public.dnd_ai_model_policies(
  tenant_id,feature,provider,model_pattern,prompt_id,prompt_version,prompt_hash,policy_version,
  max_input_tokens,max_output_tokens,input_cost_micros_per_million,output_cost_micros_per_million,active,created_by
)
select null,v.feature,v.provider,v.model_pattern,v.prompt_id,'1',v.prompt_hash,'baseline-1',128000,8000,0,0,true,null
from (values
  ('campaign.turn','mock','deterministic-local','dnd-turn','20fe5de9bbe328bc416b5a3ce016dac63d511d544918696e763b7cf714cb47a4'),
  ('homebrew.generate','mock','deterministic-local','dnd-homebrew','7094e5d0003d3b8e710c2e6ccd02ca53f81ff6c00ff6d776a0ad21fc48653271'),
  ('map.generate','mock','deterministic-local','dnd-map','b39ec18456f95ed7826952a9c5e7fce5e04ef6db4b7b95b178455043563282c1'),
  ('session.intelligence','mock','deterministic-local','dnd-session-intelligence','cba73b874a8e5b6075965315df186a5e654c36e4cd5f69b8dd8580a3044bc26e'),
  ('campaign.turn','openai','*','dnd-turn','20fe5de9bbe328bc416b5a3ce016dac63d511d544918696e763b7cf714cb47a4'),
  ('homebrew.generate','openai','*','dnd-homebrew','7094e5d0003d3b8e710c2e6ccd02ca53f81ff6c00ff6d776a0ad21fc48653271'),
  ('map.generate','openai','*','dnd-map','b39ec18456f95ed7826952a9c5e7fce5e04ef6db4b7b95b178455043563282c1'),
  ('session.intelligence','openai','*','dnd-session-intelligence','cba73b874a8e5b6075965315df186a5e654c36e4cd5f69b8dd8580a3044bc26e')
) as v(feature,provider,model_pattern,prompt_id,prompt_hash)
on conflict do nothing;

revoke all on function private.dnd_ai_default_tenant() from public,anon;
revoke all on function private.dnd_ai_scope_tenant(uuid) from public,anon;
revoke all on function private.dnd_ai_can_manage_tenant(uuid) from public,anon;
revoke all on function private.dnd_ai_generation_policy(uuid,text,text,text,text,text,text) from public,anon;
revoke all on function private.dnd_ai_budgets(uuid) from public,anon;
revoke all on function private.dnd_ai_upsert_budget(uuid,uuid,uuid,uuid,text,text,bigint,bigint,bigint,bigint,boolean) from public,anon;
revoke all on function private.dnd_ai_model_policies(uuid) from public,anon;
revoke all on function private.dnd_ai_upsert_model_policy(uuid,uuid,text,text,text,text,text,text,text,integer,integer,bigint,bigint,boolean) from public,anon;
revoke all on function private.dnd_ai_usage_event_json(public.dnd_ai_usage_events) from public,anon;
revoke all on function private.dnd_ai_insert_blocked_usage(uuid,uuid,uuid,text,text,text,text,text,text,text,text,public.dnd_ai_model_policies) from public,anon;
revoke all on function private.dnd_ai_reserve_generation(uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) from public,anon;
revoke all on function private.dnd_ai_finalize_generation(uuid,text,bigint,bigint,bigint,bigint,integer,text,text,text,jsonb) from public,anon;
revoke all on function private.dnd_ai_usage(uuid,integer) from public,anon;
revoke all on function private.dnd_ai_save_evaluation(uuid,text,text,text,text,jsonb) from public,anon;
revoke all on function private.dnd_ai_evaluations(uuid,integer) from public,anon;

grant execute on function private.dnd_ai_default_tenant() to authenticated;
grant execute on function private.dnd_ai_scope_tenant(uuid) to authenticated;
grant execute on function private.dnd_ai_can_manage_tenant(uuid) to authenticated;
grant execute on function private.dnd_ai_generation_policy(uuid,text,text,text,text,text,text) to authenticated;
grant execute on function private.dnd_ai_budgets(uuid) to authenticated;
grant execute on function private.dnd_ai_upsert_budget(uuid,uuid,uuid,uuid,text,text,bigint,bigint,bigint,bigint,boolean) to authenticated;
grant execute on function private.dnd_ai_model_policies(uuid) to authenticated;
grant execute on function private.dnd_ai_upsert_model_policy(uuid,uuid,text,text,text,text,text,text,text,integer,integer,bigint,bigint,boolean) to authenticated;
grant execute on function private.dnd_ai_usage_event_json(public.dnd_ai_usage_events) to authenticated;
grant execute on function private.dnd_ai_insert_blocked_usage(uuid,uuid,uuid,text,text,text,text,text,text,text,text,public.dnd_ai_model_policies) to authenticated;
grant execute on function private.dnd_ai_reserve_generation(uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) to authenticated;
grant execute on function private.dnd_ai_finalize_generation(uuid,text,bigint,bigint,bigint,bigint,integer,text,text,text,jsonb) to authenticated;
grant execute on function private.dnd_ai_usage(uuid,integer) to authenticated;
grant execute on function private.dnd_ai_save_evaluation(uuid,text,text,text,text,jsonb) to authenticated;
grant execute on function private.dnd_ai_evaluations(uuid,integer) to authenticated;

revoke all on function public.dnd_ai_generation_policy(uuid,text,text,text,text,text,text) from public,anon;
revoke all on function public.dnd_ai_budgets(uuid) from public,anon;
revoke all on function public.dnd_ai_upsert_budget(uuid,uuid,uuid,uuid,text,text,bigint,bigint,bigint,bigint,boolean) from public,anon;
revoke all on function public.dnd_ai_model_policies(uuid) from public,anon;
revoke all on function public.dnd_ai_upsert_model_policy(uuid,uuid,text,text,text,text,text,text,text,integer,integer,bigint,bigint,boolean) from public,anon;
revoke all on function public.dnd_ai_reserve_generation(uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) from public,anon;
revoke all on function public.dnd_ai_finalize_generation(uuid,text,bigint,bigint,bigint,bigint,integer,text,text,text,jsonb) from public,anon;
revoke all on function public.dnd_ai_usage(uuid,integer) from public,anon;
revoke all on function public.dnd_ai_save_evaluation(uuid,text,text,text,text,jsonb) from public,anon;
revoke all on function public.dnd_ai_evaluations(uuid,integer) from public,anon;

grant execute on function public.dnd_ai_generation_policy(uuid,text,text,text,text,text,text) to authenticated;
grant execute on function public.dnd_ai_budgets(uuid) to authenticated;
grant execute on function public.dnd_ai_upsert_budget(uuid,uuid,uuid,uuid,text,text,bigint,bigint,bigint,bigint,boolean) to authenticated;
grant execute on function public.dnd_ai_model_policies(uuid) to authenticated;
grant execute on function public.dnd_ai_upsert_model_policy(uuid,uuid,text,text,text,text,text,text,text,integer,integer,bigint,bigint,boolean) to authenticated;
grant execute on function public.dnd_ai_reserve_generation(uuid,uuid,text,text,text,text,text,text,bigint,bigint,text) to authenticated;
grant execute on function public.dnd_ai_finalize_generation(uuid,text,bigint,bigint,bigint,bigint,integer,text,text,text,jsonb) to authenticated;
grant execute on function public.dnd_ai_usage(uuid,integer) to authenticated;
grant execute on function public.dnd_ai_save_evaluation(uuid,text,text,text,text,jsonb) to authenticated;
grant execute on function public.dnd_ai_evaluations(uuid,integer) to authenticated;

commit;
