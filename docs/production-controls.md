# Production controls, evaluations, and monitoring

Phase 8 adds one production-control boundary around every AI provider call. Campaign turns, homebrew, maps, session intelligence, HTTP clients, and Discord commands use the same policy, budget, usage, and evaluation path.

Voice Co-DM remains excluded. This layer can support a future premium entitlement decision, but no voice provider, entitlement, billing, or payment logic is included.

## Request lifecycle

1. The outer HTTP wrapper assigns or validates `X-Khaos-Request-Id`.
2. The provider boundary resolves the feature's versioned prompt descriptor.
3. The store atomically reserves estimated input tokens, maximum output tokens, and configured cost.
4. Model policy and all matching tenant, campaign, user, and feature budgets are evaluated before provider execution.
5. A denied request is recorded as `blocked`; the provider is not invoked.
6. A permitted request executes with the approved maximum output-token limit.
7. Usage, latency, hashes, errors, and a content-free evaluation summary are finalized idempotently.
8. The full deterministic evaluation report may be stored separately for authorized campaign or tenant review.

The usage ledger stores no raw prompt or generated-output text. It stores SHA-256 input/output identities, bounded provider identifiers, usage metrics, latency, configured cost, and category outcomes.

## Evaluation suite

Baseline suite version: `baseline-1`.

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

Each category returns `pass`, `warn`, or `fail`. Evidence is represented by SHA-256 and length, not raw campaign or generation text. The baseline suite is deterministic and does not depend on a model-as-judge request.

## Budgets

Budgets can apply to:

- tenant
- campaign
- user
- feature

Periods are daily or monthly. Limits may cover requests, input tokens, output tokens, or configured micro-cost units. All matching active budgets apply. Reservations lock matching budget rows and count outstanding reservations so concurrent requests cannot overrun limits.

Provider prices are not hard-coded. Administrators explicitly configure input/output micro-cost rates on versioned model policies.

## Model and prompt policies

Every provider call must match an active policy for:

- feature
- provider
- model pattern
- prompt ID
- prompt version
- prompt SHA-256
- policy version

Policies also set maximum input/output tokens and optional cost rates. Missing or disabled policies fail closed.

The seeded baseline permits deterministic mock mode and OpenAI model wildcards for the four existing AI features. OpenAI prices remain zero until an administrator records approved current rates.

## HTTP endpoints

- `GET /health` — API version, package version, capabilities, and control versions
- `GET /api/v1/production/prompts`
- `GET|POST /api/v1/production/budgets`
- `GET|POST /api/v1/production/model-policies`
- `GET /api/v1/production/usage`
- `GET|POST /api/v1/production/evaluations`

`campaignId` and `limit` are query parameters for read endpoints. Protected Supabase mode uses the caller's access token and existing tenant/campaign roles.

## Database boundary

Tables:

- `dnd_ai_model_policies`
- `dnd_ai_budgets`
- `dnd_ai_usage_events`
- `dnd_ai_evaluation_runs`

All tables have RLS enabled, an explicit RPC-only deny policy, and no direct `anon` or `authenticated` table privileges. Public RPC wrappers are invoker-rights; private implementations are security-definer functions with fixed search paths. Anonymous execution is revoked.

Budget and model-policy writes are audited through `dnd_audit_log`.

## OpenAI usage

OpenAI Responses requests continue to use `store: false`. When the provider returns usage, Khaos Nexus records input, output, cached-input, total, and reasoning-token metrics. Provider credentials remain server-side and are never returned through health, usage, errors, or monitoring APIs.

## Non-goals

- no billing or payment provider
- no automatic upgrades
- no hard-coded retail pricing
- no raw prompt/output analytics
- no autonomous rollback
- no Voice Co-DM
