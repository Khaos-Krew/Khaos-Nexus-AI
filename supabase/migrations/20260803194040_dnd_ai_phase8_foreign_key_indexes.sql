begin;
create index if not exists dnd_ai_budgets_created_by_idx on public.dnd_ai_budgets(created_by);
create index if not exists dnd_ai_evaluation_runs_user_idx on public.dnd_ai_evaluation_runs(user_id);
create index if not exists dnd_ai_model_policies_created_by_idx on public.dnd_ai_model_policies(created_by) where created_by is not null;
create index if not exists dnd_ai_model_policies_tenant_idx on public.dnd_ai_model_policies(tenant_id) where tenant_id is not null;
create index if not exists dnd_ai_usage_events_policy_idx on public.dnd_ai_usage_events(policy_id) where policy_id is not null;
commit;
