# Khaos Nexus AI launch checklist

This checklist applies to service version `0.12.0`. A checked source-code item does not replace verification in the actual deployment environment.

## Release candidate

- [ ] `main` contains the validated launch-hardening merge.
- [ ] GitHub Actions passes dependency audit, launch tests, app-client tests, production startup smoke, full regression tests, syntax checks, and Docker build.
- [ ] The image or deployment artifact is built from the exact validated commit.
- [ ] Voice Co-DM remains absent from capabilities and configuration.

## Required runtime configuration

Production startup must fail unless all of the following are explicit and valid:

```text
NODE_ENV=production
HOST=<explicit bind host>
PORT=8787
AI_PROVIDER=openai
OPENAI_API_KEY=<server-side secret>
OPENAI_MODEL=gpt-5-mini
OPENAI_BASE_URL=https://api.openai.com/v1
CAMPAIGN_STORE=supabase
AUTH_REQUIRED=true
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
CORS_ORIGIN=https://<approved app origin>
TRUST_PROXY=<true only behind a trusted header-overwriting proxy>
```

- [ ] OpenAI and Supabase secrets are stored in the deployment secret manager, not the repository, desktop renderer, Discord, logs, or support bundles.
- [ ] `CORS_ORIGIN` is an exact approved origin and not `*`.
- [ ] `OPENAI_BASE_URL` resolves to the official OpenAI API endpoint.
- [ ] The service is exposed through HTTPS when not loopback-only.
- [ ] Proxy forwarding headers are overwritten by the trusted proxy before `TRUST_PROXY=true` is enabled.

## Database

- [ ] All migrations under `supabase/migrations` are applied in order.
- [ ] Launch-hardening functions are authenticated-only and anonymous execution is revoked.
- [ ] Active OpenAI policies target exact model `gpt-5-mini`, policy version `launch-1`.
- [ ] Zero-priced OpenAI wildcard policies are inactive.
- [ ] Security advisor has no findings.
- [ ] Performance advisor has no actionable launch blocker; unused-index notices are recorded as informational before traffic.
- [ ] Database backups and point-in-time recovery settings are confirmed before owner testing.

## Budgets

OpenAI generation fails closed without a matching active budget.

- [ ] Select the exact owner-testing tenant.
- [ ] Create a conservative active daily or monthly budget.
- [ ] Include at least a request limit and configured-cost or token limit.
- [ ] Confirm one permitted request.
- [ ] Confirm a deliberate denial after a temporary low test limit.
- [ ] Restore the approved owner-testing limit after denial testing.
- [ ] Verify usage events contain hashes/metrics rather than raw prompts and outputs.

Configured-cost accounting uses the launch policy values for standard GPT-5 mini token pricing. Review official pricing before changing the policy or model.

## Service verification

- [ ] Container or process starts without warnings or secret-bearing output.
- [ ] `/health` returns status `ok`, API version `1`, service version `0.12.0`, `openai/gpt-5-mini`, Supabase store, required authentication, production controls, and expected capabilities.
- [ ] Unauthenticated protected routes return a safe `401`.
- [ ] Invalid tenant selection returns a safe error without database details.
- [ ] Provider timeout/unavailability returns a stable retryable error without provider payloads.
- [ ] Graceful termination closes the listener during deployment restart.
- [ ] Container health check succeeds through the final runtime configuration.

## Khaos Nexus app link

Use:

- `integrations/khaos-nexus/ai-service-client.js`
- `integrations/khaos-nexus/integration-manifest.json`
- `docs/khaos-nexus-app-integration.md`

- [ ] AI client exists only in the Electron main process or another privileged Node boundary.
- [ ] Renderer IPC is allow-listed per AI action; no generic URL or path proxy exists.
- [ ] Main process supplies the current Supabase access token internally.
- [ ] Main process supplies the active tenant UUID for stateless generation.
- [ ] Renderer supplies only explicit user intent and selected/redacted campaign context.
- [ ] App calls `health()` before enabling the feature.
- [ ] App disables AI controls on version/capability mismatch.
- [ ] App displays stable safe errors and request IDs without tokens or stack traces.
- [ ] Saving, applying, posting, or executing generated content remains a separate explicit user action.

## Owner acceptance tests

- [ ] Valid login and active tenant.
- [ ] Expired login.
- [ ] Tenant switch.
- [ ] Missing/invalid tenant header.
- [ ] No matching budget.
- [ ] Request-limit denial.
- [ ] Configured-cost/token denial.
- [ ] Co-DM session preparation.
- [ ] Homebrew generation and approval boundary.
- [ ] Map generation and review boundary.
- [ ] Campaign turn state update with optimistic revision behavior.
- [ ] Session intelligence generation, save, and approval.
- [ ] Provider timeout and recovery.
- [ ] Service restart while app is open.
- [ ] No raw prompt/output in usage monitoring.
- [ ] No AI or Supabase secret in desktop logs/support bundle.

## Rollback

- [ ] Keep the previous service image/commit available.
- [ ] Disable the desktop AI feature gate before rolling back the service if contracts become incompatible.
- [ ] Do not reactivate zero-priced wildcard policies during rollback.
- [ ] Preserve usage/evaluation data and database migrations unless a separate reviewed rollback migration exists.
- [ ] Record the failing request ID, service commit, app version, tenant/campaign scope, and safe error code.
- [ ] Roll forward with a validated fix rather than editing production functions or policies manually without a migration.
