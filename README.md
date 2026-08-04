# Khaos Nexus AI

Khaos Nexus AI is the authenticated, headless D&D Game Master and Co-DM service for the Khaos Nexus ecosystem.

**Current service:** `0.12.1`  
**Production model:** `gpt-5-mini-2025-08-07`  
**API version:** `1`

Voice Co-DM is intentionally excluded and may be evaluated later as a separate premium capability.

## Production status

The production roadmap is complete:

- caller-scoped Supabase Auth, PostgreSQL RPCs, RLS, audit, and optimistic revisions
- campaign workspace tools and encounter/initiative engine
- Discord campaign binding/command bridge
- manager-reviewed session intelligence
- authorized campaign retrieval with provenance/copyright controls
- advanced GM/player map scenes, fog, approvals, and portable exports
- deterministic evaluations, model/prompt controls, budgets, usage monitoring, and cost accounting
- stateless desktop Co-DM API
- fail-closed production configuration, safe networking/errors, graceful shutdown, production smoke, and Docker health checks
- privileged Electron main-process integration client and manifest

## Core capabilities

- Game Master and Co-DM campaign turns
- stateless review-only desktop Co-DM drafts
- role-filtered campaign workspaces
- strict campaign and encounter tools
- initiative, rounds, HP/temp HP, AC, conditions, concentration, reactions, death saves, legendary actions, hidden combatants, and lair actors
- original homebrew generation, persistence, and manager approval
- reproducible maps and advanced map scenes
- GM/player session recaps, canon proposals, contradictions, and preparation
- licensed/user-owned/public-domain campaign retrieval
- Discord bindings to existing channels/threads/posts
- production budgets, usage, evaluations, and monitoring
- deterministic local/mock mode for development

## Local development

```bash
cp .env.example .env
npm ci
npm start
```

Defaults bind to `127.0.0.1:8787` with mock AI, JSON persistence, and optional auth.

```text
AI_PROVIDER=mock
CAMPAIGN_STORE=json
AUTH_REQUIRED=false
```

Verify:

```text
GET http://127.0.0.1:8787/health
```

## Production configuration

Production starts only with explicit authenticated settings:

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
```

The service rejects unsafe production combinations, moving/unreviewed models, non-HTTPS provider endpoints, wildcard CORS, service-role/secret Supabase keys, and non-loopback unauthenticated operation.

Apply migrations under `supabase/migrations` in order before deployment.

## OpenAI data handling

Requests use the Responses API with strict JSON Schema and `store: false`. This service does not use OpenAI conversations, files, background mode, or provider tools.

`store: false` does **not** by itself guarantee Zero Data Retention. OpenAI project data controls govern provider abuse-monitoring retention. Review the actual API project and separately configure Modified Abuse Monitoring or Zero Data Retention only when eligible/approved. Do not describe the service as “zero retention” unless ZDR is enabled for the deployed project.

The OpenAI key remains server-side and must never enter desktop renderer code, Discord payloads, browser bundles, logs, or committed files.

## Authorization and budgets

Every protected request carries the caller's verified Supabase access token. PostgreSQL remains authoritative for tenant/campaign role checks and filtered data.

OpenAI generation fails closed unless:

- the caller is authenticated and authorized
- campaign scope is valid, or stateless generation supplies an authorized `X-Khaos-Tenant-Id`
- an exact active model/prompt policy matches
- a matching active budget exists
- token/output/configured-cost limits allow the reservation

Usage monitoring stores bounded metrics, identifiers, and hashes rather than raw prompts/outputs.

## Desktop integration

Use these artifacts from the Electron main process only:

- `integrations/khaos-nexus/ai-service-client.js`
- `integrations/khaos-nexus/integration-manifest.json`
- `docs/khaos-nexus-app-integration.md`

The client requires service `0.12.1+`, API `1`, and capability `dnd.co-dm.draft`. It obtains Supabase access tokens and active tenant IDs internally, sends correlated request IDs, and returns stable safe errors.

Do not implement a generic renderer-to-AI proxy or store the OpenAI key in the desktop app.

## Key API groups

| Group | Representative routes |
|---|---|
| Health/capabilities | `GET /health` |
| Desktop Co-DM | `POST /api/v1/dnd/co-dm/drafts` |
| Campaigns/workspace | `/api/v1/campaigns`, `/workspace`, `/turns`, `/tools/execute` |
| Encounters | `/encounters/:id`, `/encounters/tools/execute` |
| Homebrew | `/homebrew/generations`, campaign draft/approve routes |
| Session intelligence | `/sessions/:id/intelligence/{generate,save,approve}` |
| Retrieval | `/retrieval/sources`, `/entries`, `/search` |
| Maps/scenes | `/maps/generations`, `/map-scenes`, generate/approve/export routes |
| Discord bridge | `/api/v1/discord/commands`, campaign binding/verification routes |
| Production controls | `/api/v1/production/{prompts,model-policies,budgets,usage,evaluations}` |
| Dice | `POST /api/v1/dice/rolls` |

See source contracts and focused docs for exact request/response schemas.

## Safety and content boundaries

- Player agency is preserved; AI does not decide player-character thoughts/dialogue/irreversible actions.
- Safety lines, veils, pause words, and content ratings are included in campaign context.
- Tools and persistence require explicit validated calls; generation does not silently execute campaign changes.
- Homebrew/retrieval/map flows reject exact-copy, full-text reconstruction, and commercial-map recreation requests.
- Role-filtered GM secrets and hidden encounter/map data are filtered in PostgreSQL.
- Voice Co-DM, arbitrary provider selection, provider tools, and autonomous posting/actions are excluded.

## Validation

```bash
npm ci
npm audit --omit=dev
npm run test:launch
npm run test:integration
npm run smoke:production
npm test
npm run build
docker build -t khaos-nexus-ai .
```

CI runs these gates plus every focused Discord, retrieval, map, production-control, session, encounter, homebrew, campaign, and migration suite.

Before launch, complete `docs/launch-checklist.md`, including real tenant/budget setup, final HTTPS health verification, OpenAI project data-control review, and owner acceptance tests.

## Architecture

```text
Khaos Nexus Electron main process / Discord Bot Core
                         |
                 Supabase access token
          request ID + explicit tenant when needed
                         |
                         v
                  Khaos Nexus AI
       auth / validation / budgets / evaluations
          /              |                 \
 campaign RPCs      AI provider       Discord adapter
       |
PostgreSQL RLS + private implementations + audit
```

Production-Control tracked implementation issues and PRs are closed. Future changes must start from a new issue, exact `main` commit, assigned branch, and full release validation.
