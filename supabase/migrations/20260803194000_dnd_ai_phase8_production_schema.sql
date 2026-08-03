begin;

create table if not exists public.dnd_ai_model_policies (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid references public.nexus_tenants(id) on delete cascade,
  feature text not null check (length(feature) between 1 and 100),
  provider text not null check (length(provider) between 1 and 80),
  model_pattern text not null default '*' check (length(model_pattern) between 1 and 200),
  prompt_id text not null check (length(prompt_id) between 1 and 120),
  prompt_version text not null check (length(prompt_version) between 1 and 80),
  prompt_hash text not null check (prompt_hash ~ '^[a-f0-9]{64}$'),
  policy_version text not null check (length(policy_version) between 1 and 80),
  max_input_tokens integer not null check (max_input_tokens between 1 and 2000000),
  max_output_tokens integer not null check (max_output_tokens between 1 and 200000),
  input_cost_micros_per_million bigint not null default 0 check (input_cost_micros_per_million >= 0),
  output_cost_micros_per_million bigint not null default 0 check (output_cost_micros_per_million >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists dnd_ai_model_policies_identity_idx
on public.dnd_ai_model_policies(
  coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  feature, provider, model_pattern, prompt_id, prompt_version, prompt_hash, policy_version
);
create index if not exists dnd_ai_model_policies_lookup_idx
on public.dnd_ai_model_policies(feature, provider, active, tenant_id);

create table if not exists public.dnd_ai_budgets (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.nexus_tenants(id) on delete cascade,
  campaign_id uuid references public.dnd_campaigns(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  feature text check (feature is null or length(feature) between 1 and 100),
  period text not null check (period in ('daily','monthly')),
  request_limit bigint check (request_limit is null or request_limit >= 0),
  input_token_limit bigint check (input_token_limit is null or input_token_limit >= 0),
  output_token_limit bigint check (output_token_limit is null or output_token_limit >= 0),
  cost_limit_micros bigint check (cost_limit_micros is null or cost_limit_micros >= 0),
  active boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (request_limit is not null or input_token_limit is not null or output_token_limit is not null or cost_limit_micros is not null)
);

create index if not exists dnd_ai_budgets_scope_idx
on public.dnd_ai_budgets(tenant_id, campaign_id, user_id, feature, active, period);
create index if not exists dnd_ai_budgets_campaign_idx on public.dnd_ai_budgets(campaign_id) where campaign_id is not null;
create index if not exists dnd_ai_budgets_user_idx on public.dnd_ai_budgets(user_id) where user_id is not null;

create table if not exists public.dnd_ai_usage_events (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null unique,
  tenant_id uuid references public.nexus_tenants(id) on delete set null,
  campaign_id uuid references public.dnd_campaigns(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete restrict,
  policy_id uuid references public.dnd_ai_model_policies(id) on delete set null,
  feature text not null check (length(feature) between 1 and 100),
  provider text not null check (length(provider) between 1 and 80),
  model text not null check (length(model) between 1 and 200),
  prompt_id text not null check (length(prompt_id) between 1 and 120),
  prompt_version text not null check (length(prompt_version) between 1 and 80),
  prompt_hash text not null check (prompt_hash ~ '^[a-f0-9]{64}$'),
  policy_version text,
  input_hash text not null check (input_hash ~ '^[a-f0-9]{64}$'),
  output_hash text check (output_hash is null or output_hash ~ '^[a-f0-9]{64}$'),
  provider_request_id text not null default '' check (length(provider_request_id) <= 200),
  status text not null check (status in ('reserved','succeeded','failed','blocked')),
  block_reason text check (block_reason is null or length(block_reason) <= 120),
  error_code text check (error_code is null or length(error_code) <= 120),
  estimated_input_tokens bigint not null default 0 check (estimated_input_tokens >= 0),
  reserved_output_tokens bigint not null default 0 check (reserved_output_tokens >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cached_input_tokens bigint not null default 0 check (cached_input_tokens >= 0),
  reasoning_tokens bigint not null default 0 check (reasoning_tokens >= 0),
  input_cost_micros_per_million bigint not null default 0 check (input_cost_micros_per_million >= 0),
  output_cost_micros_per_million bigint not null default 0 check (output_cost_micros_per_million >= 0),
  reserved_cost_micros bigint not null default 0 check (reserved_cost_micros >= 0),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  evaluation_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finalized_at timestamptz
);

create index if not exists dnd_ai_usage_tenant_created_idx on public.dnd_ai_usage_events(tenant_id, created_at desc);
create index if not exists dnd_ai_usage_campaign_created_idx on public.dnd_ai_usage_events(campaign_id, created_at desc) where campaign_id is not null;
create index if not exists dnd_ai_usage_user_created_idx on public.dnd_ai_usage_events(user_id, created_at desc);
create index if not exists dnd_ai_usage_budget_daily_idx on public.dnd_ai_usage_events(tenant_id, campaign_id, user_id, feature, created_at) where status <> 'blocked';

create table if not exists public.dnd_ai_evaluation_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid references public.nexus_tenants(id) on delete set null,
  campaign_id uuid references public.dnd_campaigns(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete restrict,
  feature text not null check (length(feature) between 1 and 100),
  suite_version text not null check (length(suite_version) between 1 and 80),
  artifact_hash text not null check (artifact_hash ~ '^[a-f0-9]{64}$'),
  outcome text not null check (outcome in ('pass','warn','fail')),
  report jsonb not null,
  created_at timestamptz not null default now(),
  check (octet_length(report::text) <= 200000)
);

create index if not exists dnd_ai_evaluations_campaign_created_idx on public.dnd_ai_evaluation_runs(campaign_id, created_at desc) where campaign_id is not null;
create index if not exists dnd_ai_evaluations_tenant_created_idx on public.dnd_ai_evaluation_runs(tenant_id, created_at desc);

alter table public.dnd_ai_model_policies enable row level security;
alter table public.dnd_ai_budgets enable row level security;
alter table public.dnd_ai_usage_events enable row level security;
alter table public.dnd_ai_evaluation_runs enable row level security;

revoke all on table public.dnd_ai_model_policies from public, anon, authenticated;
revoke all on table public.dnd_ai_budgets from public, anon, authenticated;
revoke all on table public.dnd_ai_usage_events from public, anon, authenticated;
revoke all on table public.dnd_ai_evaluation_runs from public, anon, authenticated;

create policy dnd_ai_model_policies_rpc_only on public.dnd_ai_model_policies for all using (false) with check (false);
create policy dnd_ai_budgets_rpc_only on public.dnd_ai_budgets for all using (false) with check (false);
create policy dnd_ai_usage_events_rpc_only on public.dnd_ai_usage_events for all using (false) with check (false);
create policy dnd_ai_evaluation_runs_rpc_only on public.dnd_ai_evaluation_runs for all using (false) with check (false);

commit;
