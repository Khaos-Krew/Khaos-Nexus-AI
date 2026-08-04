# Production controls, evaluations, and monitoring

One production-control boundary wraps every AI provider call. Campaign turns, homebrew, maps, session intelligence, desktop Co-DM, HTTP, and Discord generation use the same policy, budget, usage, and evaluation path.

Voice Co-DM remains excluded. No voice provider, entitlement, billing, or payment logic is included.

## Request lifecycle

1. The HTTP boundary assigns/validates `X-Khaos-Request-Id` and authorized tenant/campaign scope.
2. The provider boundary resolves the feature's versioned prompt descriptor.
3. The store atomically reserves estimated input, maximum output, and configured cost.
4. Exact model policy and all matching tenant/campaign/user/feature budgets are evaluated before provider execution.
5. A denied request is recorded as `blocked`; the provider is not invoked.
6. A permitted request executes with the approved output-token limit.
7. Usage, latency, hashes, safe errors, and content-free evaluation summary are finalized idempotently.
8. Authorized managers may inspect stored evaluation reports.

The usage ledger stores no raw prompt/generated-output text. It stores SHA-256 identities, bounded provider identifiers, usage metrics, latency, configured cost, and category outcomes.

## Evaluation suite

Suite version: `baseline-1`.

Categories:

- `player_agency`
- `secret_leakage`
- `lore_consistency`
- `mechanics`
- `homebrew_balance`
- `copyright`
- `map_integrity`
- `latency`
- `cost`

Each returns `pass`, `warn`, or `fail`. Evidence is represented by hashes and lengths rather than raw campaign/generation text. The baseline suite is deterministic and does not make a model-as-judge request.

## Budgets

Budgets can apply to tenant, campaign, user, feature, and daily/monthly periods. Limits cover request count, input tokens, output tokens, and configured micro-cost units. All matching active budgets apply. Matching rows are locked and outstanding reservations count toward limits so concurrent requests cannot overrun them.

OpenAI generation fails closed when no matching active budget exists.

## Model and prompt policies

Every call must match an active policy for:

- feature
- provider
- exact model/model pattern
- prompt ID/version/SHA-256
- policy version
- maximum input/output tokens
- configured input/output rates

Missing or disabled policies fail closed.

Production global OpenAI policies use:

- model: `gpt-5-mini-2025-08-07`
- policy version: `launch-2`
- input: `250000` micro-cost units per million tokens
- output: `2000000` micro-cost units per million tokens

The moving `gpt-5-mini` alias and zero-priced wildcard policies are inactive. Changing snapshot, model family, prompts, or rates requires a new reviewed policy migration and evaluations.

Mock development policies remain zero-cost and deterministic.

## HTTP endpoints

- `GET /health`
- `GET /api/v1/production/prompts`
- `GET|POST /api/v1/production/budgets`
- `GET|POST /api/v1/production/model-policies`
- `GET /api/v1/production/usage`
- `GET|POST /api/v1/production/evaluations`

Protected Supabase mode uses the caller's access token and existing tenant/campaign roles.

## Database boundary

Tables:

- `dnd_ai_model_policies`
- `dnd_ai_budgets`
- `dnd_ai_usage_events`
- `dnd_ai_evaluation_runs`

All have RLS, RPC-only deny policies, and no direct `anon`/`authenticated` table privileges. Public wrappers use invoker rights; private implementations use security definer with fixed search paths. Anonymous execution is revoked. Budget/model-policy writes are audited.

## OpenAI request and retention boundary

Responses requests:

- use the pinned snapshot
- set `store: false`
- use strict JSON Schema
- set bounded `max_output_tokens`
- do not use conversations, files, background mode, or provider tools
- record returned input/output/cached/reasoning token metrics

`store: false` prevents the service from requesting persisted response objects. It is not a Zero Data Retention guarantee. OpenAI project data controls govern abuse-monitoring retention. Operators must separately review/configure Modified Abuse Monitoring or Zero Data Retention when eligible and must not claim ZDR unless enabled for the deployed API project.

Provider credentials remain server-side and never appear in health, usage, errors, monitoring APIs, desktop renderer state, or Discord payloads.

## Non-goals

- billing/payment collection
- automatic plan upgrades
- raw prompt/output analytics
- autonomous rollback/actions
- arbitrary provider/model selection
- Voice Co-DM
