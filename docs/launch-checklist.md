# Khaos Nexus AI launch checklist

This checklist applies to service version `0.12.1`. Source validation does not replace verification in the actual deployment accounts and network.

## Release candidate

- [ ] `main` contains the validated `0.12.1` merge.
- [ ] GitHub Actions passes dependency audit, launch tests, app-client tests, production startup smoke, full regression tests, syntax checks, and Docker build.
- [ ] The image or deployment artifact is built from the exact validated commit.
- [ ] Voice Co-DM remains absent from capabilities and configuration.

## Required runtime configuration

```text
NODE_ENV=production
HOST=<explicit bind host>
PORT=8787
AI_PROVIDER=openai
OPENAI_API_KEY=<server-side secret>
OPENAI_MODEL=gpt-5-mini-2025-08-07
OPENAI_BASE_URL=https://api.openai.com/v1
CAMPAIGN_STORE=supabase
AUTH_REQUIRED=true
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
CORS_ORIGIN=https://<approved app origin>
TRUST_PROXY=<true only behind a trusted header-overwriting proxy>
```

- [ ] Secrets are stored only in the deployment secret manager.
- [ ] `CORS_ORIGIN` is exact and not `*`.
- [ ] `OPENAI_BASE_URL` is the official HTTPS API endpoint.
- [ ] `OPENAI_MODEL` is the pinned snapshot, not `gpt-5-mini` or another alias/model.
- [ ] Non-loopback traffic is HTTPS.
- [ ] Forwarding headers are overwritten by the trusted proxy before `TRUST_PROXY=true`.

## OpenAI project data controls

The service sends `store: false` and does not use conversations, files, background mode, or provider tools. This is not by itself a Zero Data Retention guarantee.

- [ ] Review the actual OpenAI project under Organization/Project Data controls.
- [ ] Record whether the project uses default retention, Modified Abuse Monitoring, or Zero Data Retention.
- [ ] Do not claim MAM/ZDR unless the organization is approved and the setting is enabled for the exact API project/key.
- [ ] Ensure desktop privacy copy distinguishes response-object storage from provider abuse-monitoring retention.
- [ ] Confirm prompts/outputs are not intentionally opted into provider model-improvement sharing.
- [ ] Re-review these controls when changing API project, organization, endpoint, background mode, tools, files, or model family.

## Database

- [ ] All migrations under `supabase/migrations` are applied in order.
- [ ] Launch functions are authenticated-only and anonymous execution is revoked.
- [ ] Active global OpenAI policies target `gpt-5-mini-2025-08-07`, policy `launch-2`.
- [ ] Moving aliases and zero-priced wildcard OpenAI policies are inactive.
- [ ] Security advisor has no findings.
- [ ] Performance advisor has no actionable launch blocker; pre-traffic unused-index notices are informational.
- [ ] Backups and point-in-time recovery are confirmed before owner testing.

## Budgets

OpenAI generation fails closed without a matching active budget.

- [ ] Select the exact owner-testing tenant.
- [ ] Create a conservative active daily or monthly budget.
- [ ] Include a request limit and configured-cost or token limit.
- [ ] Confirm one permitted request.
- [ ] Confirm a deliberate denial with a temporary low limit.
- [ ] Restore the approved owner-testing limit.
- [ ] Verify usage events contain hashes/metrics, not raw prompts or outputs.

Configured-cost accounting uses the reviewed standard GPT-5 mini values stored in the launch policy. Recheck official pricing before changing the snapshot, model, or prices.

## Service verification

- [ ] Process/container starts without secret-bearing output.
- [ ] `/health` returns status `ok`, API `1`, service `0.12.1`, `openai/gpt-5-mini-2025-08-07`, Supabase store, required authentication, production controls, and expected capabilities.
- [ ] Unauthenticated protected routes return safe `401` responses.
- [ ] Invalid tenant selection returns no database details.
- [ ] Provider failure returns a stable retryable error without provider payloads.
- [ ] Graceful termination closes the listener during restart.
- [ ] Container health check succeeds through the final runtime configuration.

## Khaos Nexus app link

Use:

- `integrations/khaos-nexus/ai-service-client.js`
- `integrations/khaos-nexus/integration-manifest.json`
- `docs/khaos-nexus-app-integration.md`

- [ ] Client exists only in Electron main/privileged Node code.
- [ ] Renderer IPC is allow-listed per action; no generic request proxy exists.
- [ ] Main process obtains current Supabase token and active tenant internally.
- [ ] Renderer sends only explicit intent and selected/redacted campaign context.
- [ ] App requires health API `1`, service `0.12.1+`, and required capabilities.
- [ ] App displays safe errors/request IDs without tokens or stack traces.
- [ ] App privacy copy does not claim zero provider retention unless the deployed OpenAI project actually has ZDR enabled.
- [ ] Applying, saving, posting, or executing generated material remains a separate explicit action.

## Owner acceptance tests

- [ ] Valid and expired login.
- [ ] Tenant switch and invalid/missing tenant.
- [ ] Missing budget, request denial, token/configured-cost denial.
- [ ] Co-DM, homebrew, map, campaign turn, and session intelligence flows.
- [ ] Provider timeout/recovery and service restart while app is open.
- [ ] Model reported by `/health` exactly matches the pinned snapshot.
- [ ] No raw prompt/output in service monitoring.
- [ ] No OpenAI or Supabase secret in desktop logs/support bundles.

## Rollback

- [ ] Keep the previous service image/commit available.
- [ ] Disable the desktop AI feature gate before an incompatible service rollback.
- [ ] Do not reactivate moving aliases or zero-priced wildcard policies.
- [ ] Preserve usage/evaluation data and migrations unless a reviewed rollback migration exists.
- [ ] Record request ID, service commit, app version, tenant/campaign scope, safe error code, and provider project.
- [ ] Prefer a validated roll-forward fix over manual production edits.
