# Khaos Nexus AI

Khaos Nexus AI is the authenticated, headless D&D Game Master and Co-DM service for the Khaos Nexus ecosystem. It supports campaign state, permission-aware campaign tools, copyright-safe homebrew, procedural maps, dice, and Supabase/PostgreSQL persistence while remaining usable in offline local-development mode.

Voice Co-DM is intentionally deferred. It may be evaluated later as a premium feature after authorization, campaign workflows, usage budgets, and cost controls are mature.

## Included

- Game Master and Co-DM campaign turns
- Local JSON persistence or caller-scoped Supabase/PostgreSQL persistence
- Supabase Auth bearer-token verification
- RLS-authorized campaign lists and role-filtered workspaces
- Transactional campaign creation and AI-state updates
- Audited homebrew creation and DM approval
- Eight strict, allow-listed campaign workspace tools
- Copyright-safe original homebrew generation
- Procedural and AI-assisted maps with reproducible seeds and SVG previews
- D&D dice notation, safety lines, veils, ratings, and pause words
- OpenAI structured output or deterministic offline mock mode
- Zero runtime dependencies, Docker, tests, and GitHub Actions CI

## Local development

```bash
cp .env.example .env
npm ci
npm start
```

Defaults:

```text
AI_PROVIDER=mock
CAMPAIGN_STORE=json
AUTH_REQUIRED=false
```

Open `http://localhost:8787/health` to verify the service.

## Production Supabase mode

Apply the ordered files under `supabase/migrations`, then configure:

```bash
CAMPAIGN_STORE=supabase
AUTH_REQUIRED=true
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Use a publishable key only. The service rejects values that resemble Supabase service-role or `sb_secret_` credentials. Each Data API request includes both the publishable key and the caller's personal access token:

```http
apikey: sb_publishable_...
Authorization: Bearer <user-access-token>
```

This keeps PostgreSQL authorization and campaign roles authoritative. `/health` remains public; Supabase mode requires authentication for `/api/v1/*`.

## OpenAI mode

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5-mini
```

OpenAI requests use `store: false`. Keep keys server-side and out of browser bundles, desktop renderers, Discord payloads, and committed files.

## API routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Service, provider, persistence, and authentication status |
| `GET` | `/api/v1/me` | Verified user context |
| `GET` | `/api/v1/workspace-tools` | Discover the fixed campaign-tool allow-list |
| `GET` | `/api/v1/campaigns` | List campaigns visible to the caller |
| `GET` | `/api/v1/campaigns/:id` | Load AI-compatible campaign state |
| `GET` | `/api/v1/campaigns/:id/workspace` | Load role-filtered workspace data |
| `POST` | `/api/v1/campaigns` | Create a campaign and initial characters |
| `POST` | `/api/v1/campaigns/:id/turns` | Generate, audit, and persist an AI turn |
| `POST` | `/api/v1/campaigns/:id/tools/execute` | Execute one validated workspace tool |
| `POST` | `/api/v1/homebrew/generations` | Generate homebrew without persistence |
| `POST` | `/api/v1/campaigns/:id/homebrew/generations` | Generate and persist draft homebrew |
| `POST` | `/api/v1/campaigns/:id/homebrew/:homebrewId/approve` | Approve homebrew as a campaign manager |
| `POST` | `/api/v1/maps/generations` | Generate structured map data and SVG |
| `POST` | `/api/v1/dice/rolls` | Roll validated dice notation |

## Controlled campaign workspace tools

Generation and execution are deliberately separate. An AI response or client may propose a tool call, but campaign data changes only when an authenticated caller sends an explicit execution request.

The fixed allow-list is:

- `upsert_npc`
- `upsert_location`
- `upsert_faction`
- `upsert_quest`
- `upsert_loot`
- `upsert_session`
- `approve_session_recap`
- `upsert_calendar_event`

Each tool has its own strict argument schema. Unknown tool names and undeclared fields are rejected. The database RPC contains a matching static `CASE` allow-list and does not use dynamic SQL, arbitrary table names, or free-form state patches.

Example:

```bash
curl -X POST \
  http://localhost:8787/api/v1/campaigns/CAMPAIGN_ID/tools/execute \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "upsert_npc",
    "arguments": {
      "name": "Ember Warden",
      "publicSummary": "A guarded smith who protects the lower forge.",
      "gmNotes": "Secretly reports to the Crucible faction.",
      "revealed": false,
      "metadata": {
        "public": { "disposition": "wary" }
      }
    }
  }'
```

All Phase 2 tools require campaign-management permission in Supabase mode. Every successful mutation writes a `dnd_audit_log` entry containing the actor, campaign, action, target type, and target ID.

### Visibility and approval rules

- NPCs, locations, and factions are hidden from players until explicitly revealed.
- Quests have explicit lifecycle status and player visibility.
- Loot can be shared, GM-only, or assigned to a character in the same campaign.
- Calendar events can be campaign-visible or DM-only.
- Session recap changes clear any prior approval.
- Only campaign managers can approve a recap for player visibility.
- Character and session references are verified against the same campaign.

## Campaign workspace visibility

`GET /api/v1/campaigns/:id/workspace` returns a database-filtered projection based on the caller's role.

DMs, assistant DMs, and tenant administrators receive management data. Players and viewers receive only appropriate data, such as revealed entities, visible quests, permitted loot, approved recaps, non-hidden encounter information, approved homebrew, and their own drafts.

GM notes, hidden metadata, private AI state, unapproved recaps, and hidden combatants are removed inside PostgreSQL rather than relying on client-side hiding.

## Homebrew copyright boundary

- Use original concepts, summaries, high-level mechanics, licensed notes, public-domain material, or genuinely short excerpts.
- Short excerpts and total inspiration text are size-limited.
- Exact-copy, verbatim, full-text, and reconstruction requests are rejected before provider invocation.
- Raw inspiration is not persisted by generation endpoints.
- Output includes provenance labels, transformed signals, balance guidance, and an originality assessment.
- Only campaign managers may approve homebrew.

These controls reduce copying risk but are not legal advice.

## Map generation

Supported map types are `encounter`, `dungeon`, `settlement`, `region`, and `travel`. Responses contain validated structured data plus an SVG preview. Identical complete requests and seeds produce identical maps in procedural/mock mode.

Requests to copy or reconstruct published commercial maps are rejected before generation.

## Architecture

```text
Windows / Discord / web clients
              |
       Supabase Auth JWT
              |
              v
       Khaos Nexus AI API
       /       |         \
 Campaigns   Tools       Generators
      |         |          /      \
      v         v       Homebrew   Maps
 Authenticated Supabase RPC      AI provider
              |
      PostgreSQL roles + audit
```

- `src/app.js` owns HTTP routing, authentication gates, and orchestration.
- `src/workspace-tools.js` owns the public tool allow-list and strict request validation.
- `src/supabase.js` owns Auth verification, caller-scoped RPC requests, and Supabase persistence.
- `src/store.js` owns deterministic local persistence and local tool execution.
- `src/domain.js`, `src/homebrew.js`, `src/maps.js`, `src/ai.js`, and `src/dice.js` own their respective contracts and engines.

## Database migrations

Phase 1 migrations add authentication-oriented RPCs, filtered workspace reads, transactional campaign state, homebrew approval, RLS policy corrections, and supporting indexes.

Phase 2 adds `dnd_ai_execute_workspace_tool`, a manager-only, audited RPC containing the same fixed eight-tool allow-list used by the API validator.

Privileged implementations live in the non-exposed `private` schema. Narrow public wrappers are executable only by authenticated users; public and anonymous execute permissions are revoked.

## Validate

```bash
npm ci
npm test
npm run build
```

After database changes, review Supabase security and performance advisors before release.

## Security baseline

- No database-bypass key is accepted by the application.
- User access tokens are verified before protected routes run.
- Data API calls carry the caller's JWT so database authorization remains authoritative.
- Workspace tools are allow-listed twice: in JavaScript validation and in static PostgreSQL control flow.
- Tool execution requires campaign-management permission and writes audit records.
- Session recap approval is invalidated when the draft changes.
- Request bodies are size-limited, validated, rate-limited, and served with defensive headers.
- OpenAI requests use `store: false`.
- Copyright checks execute before AI provider invocation.

## Roadmap

Production work is tracked in Issue #10. Phase 1 and Phase 2 establish authentication, persistence, visibility, approvals, and controlled campaign tools. Next phases cover the encounter engine, Discord integration, session intelligence, authorized retrieval, advanced VTT maps, and evaluations/cost controls.

Voice Co-DM remains deferred as a separate possible premium feature.
