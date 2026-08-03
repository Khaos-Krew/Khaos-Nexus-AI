# Khaos Nexus AI

Khaos Nexus AI is the authenticated, headless D&D Game Master and Co-DM service for the Khaos Nexus ecosystem. It supports campaign state, copyright-safe homebrew, procedural maps, dice, and a Supabase-backed campaign workspace while remaining usable in offline local-development mode.

## Included

- Game Master and Co-DM campaign turns
- Local JSON persistence or caller-scoped Supabase/PostgreSQL persistence
- Supabase Auth Bearer-token verification
- RLS-authorized campaign lists and filtered campaign workspaces
- Characters, members, revealed NPCs, locations, factions, quests, loot, approved recaps, encounters, and homebrew workspace data
- Transactional campaign creation and AI-state updates
- Audited homebrew creation and DM approval
- Copyright-safe original homebrew generation
- Procedural and AI-assisted encounter, dungeon, settlement, region, and travel maps
- Reproducible map seeds and SVG previews
- Dice notation such as `1d20+5`, `2d20kh1+3`, and `2d20kl1`
- Lines, veils, content ratings, and pause words
- OpenAI structured output or deterministic offline mock mode
- Zero runtime dependencies, Docker, tests, and GitHub Actions CI

Voice Co-DM is intentionally deferred and is not part of this build. It may be evaluated later as a premium feature after authorization, usage budgets, and campaign-state workflows are mature.

## Requirements

- Node.js 22 or newer
- npm
- An OpenAI API key only for `AI_PROVIDER=openai`
- A Supabase project and publishable key only for `CAMPAIGN_STORE=supabase`

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

Apply the ordered migrations under `supabase/migrations`, then configure:

```bash
CAMPAIGN_STORE=supabase
AUTH_REQUIRED=true
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Use a **publishable** key only. The service rejects values that look like Supabase secret or service-role keys. Every Data API request also carries the caller's personal Supabase Auth JWT:

```http
apikey: sb_publishable_...
Authorization: Bearer <user-access-token>
```

This keeps PostgreSQL RLS and the user's campaign role authoritative. The AI service never receives or uses a database-bypass key.

Supabase Auth access tokens are verified against `/auth/v1/user` before protected routes execute. In Supabase mode all `/api/v1/*` routes require a valid Bearer token; `/health` remains unauthenticated.

## OpenAI mode

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5-mini
```

OpenAI requests use `store: false`. Keep the API key server-side and out of browser bundles, desktop renderers, Discord payloads, and committed environment files.

## API routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Service, provider, persistence, and authentication status |
| `GET` | `/api/v1/me` | Verified Supabase user context |
| `GET` | `/api/v1/campaigns` | List campaigns visible to the caller |
| `GET` | `/api/v1/campaigns/:id` | Load AI-compatible campaign state |
| `GET` | `/api/v1/campaigns/:id/workspace` | Load role-filtered campaign workspace data |
| `POST` | `/api/v1/campaigns` | Transactionally create a campaign and initial characters |
| `POST` | `/api/v1/campaigns/:id/turns` | Generate, audit, and persist an AI turn |
| `POST` | `/api/v1/homebrew/generations` | Generate original homebrew without persistence |
| `POST` | `/api/v1/campaigns/:id/homebrew/generations` | Generate and persist a draft homebrew entry |
| `POST` | `/api/v1/campaigns/:id/homebrew/:homebrewId/approve` | DM-approve a homebrew revision |
| `POST` | `/api/v1/maps/generations` | Generate structured map data and an SVG preview |
| `POST` | `/api/v1/dice/rolls` | Roll validated dice notation |

## Authenticated campaign creation

Supabase mode requires a tenant UUID and Bearer token:

```bash
curl -X POST http://localhost:8787/api/v1/campaigns \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tenantId": "00000000-0000-4000-8000-000000000000",
    "name": "Emberforge Rising",
    "mode": "co-dm",
    "tone": "Dark heroic fantasy with hopeful victories",
    "playerCharacters": [
      {
        "name": "Vorkesh Emberforge",
        "summary": "Dragonborn artificer with arcane power glowing through his scales."
      }
    ],
    "safety": {
      "lines": ["Sexual violence"],
      "veils": ["Graphic torture"],
      "pauseWords": ["pause", "red card"]
    }
  }'
```

The database RPC verifies tenant membership, creates the campaign and characters in one transaction, and writes a `dnd_audit_log` event.

## Campaign workspace visibility

`GET /api/v1/campaigns/:id/workspace` returns a filtered JSON workspace based on the caller's campaign role.

DM, assistant-DM, and tenant administrators receive complete campaign-management data. Players and viewers receive only appropriate information, including:

- Revealed NPCs, locations, and factions
- Player-visible quests
- Shared loot or loot assigned to their own character
- Approved session recaps
- Active/completed encounters with hidden combatants removed
- Approved homebrew and their own drafts

GM notes, hidden metadata, unapproved recaps, hidden combatants, and private AI state are removed for non-managers. This filtering occurs inside authenticated PostgreSQL functions rather than trusting client-side hiding.

## Homebrew copyright boundary

- Use original concepts, summaries, high-level mechanics, licensed notes, public-domain material, or genuinely short excerpts.
- `short-excerpt` inspiration is capped at 700 characters per entry.
- Other summaries are capped at 1,800 characters per entry and 6,000 characters total.
- Exact-copy, verbatim, full-text, and reconstruction requests are rejected before model invocation.
- Raw inspiration is not persisted by the generation endpoint.
- Output includes transformed design signals, balance guidance, provenance labels, and an originality assessment.
- Only campaign managers may approve homebrew. Authors can edit only draft or submitted entries.

These controls reduce copying risk but are not legal advice.

## Map generation

Supported map types are `encounter`, `dungeon`, `settlement`, `region`, and `travel`. Responses include validated structured data plus a locally rendered SVG preview. Identical complete requests and seeds produce identical maps in procedural/mock mode.

Requests to copy or reconstruct published commercial maps are rejected before generation.

## Architecture

```text
Windows / Discord / web clients
              |
       Supabase Auth JWT
              |
              v
       Khaos Nexus AI API
       /       |        \
 Campaigns  Homebrew    Maps
      |          \        /
      v           AI Provider
 Supabase RPC     mock | OpenAI
      |
 PostgreSQL RLS + audit
```

- `src/app.js` owns HTTP routing, authentication gates, and orchestration.
- `src/supabase.js` owns Auth verification, caller-scoped Data API requests, and the Supabase campaign store.
- `src/store.js` owns local JSON/memory persistence and local workspace behavior.
- `src/domain.js` owns campaign and turn validation.
- `src/homebrew.js` owns homebrew policy and contracts.
- `src/maps.js` owns map validation, procedural generation, and SVG rendering.
- `src/ai.js` owns provider abstraction and structured model output.
- `src/dice.js` owns dice parsing and rolling.

## Database migrations

The ordered Phase 1 files under `supabase/migrations` add:

- RLS-supporting indexes and corrected combatant/homebrew policies
- Authenticated campaign-list and role-filtered workspace RPCs
- Transactional campaign creation and optimistic AI-state updates
- Audited homebrew creation and manager-only approval
- Explicit authenticated-only function grants

The RPC design is intentional: several existing tables contain both player-visible and GM-only columns, so broad table SELECT policies would leak private fields. Filtered database functions return only role-appropriate projections.

## Validate

```bash
npm ci
npm test
npm run build
```

After applying database changes, run Supabase security and performance advisors and review every warning before release.

## Docker

Local JSON/mock mode:

```bash
docker build -t khaos-nexus-ai .
docker run --rm -p 8787:8787 \
  -e AI_PROVIDER=mock \
  -e CAMPAIGN_STORE=json \
  -v khaos-nexus-ai-data:/app/data \
  khaos-nexus-ai
```

## Security baseline

- No service-role or Supabase secret key is accepted by the application.
- User access tokens are verified before protected routes run.
- Data API calls use the caller's JWT so RLS remains authoritative.
- Privileged database functions live in the non-exposed `private` schema and are reached through narrow authenticated wrappers.
- Public and anonymous execute permissions are revoked from Phase 1 RPCs.
- Campaign writes use optimistic concurrency to prevent lost AI-state updates.
- Campaign and homebrew mutations write audit events.
- Request bodies are size-limited, validated, rate-limited, and receive defensive HTTP headers.
- OpenAI requests use `store: false`.
- Copyright checks execute before AI provider invocation.
- Authentication and RLS are not substitutes for deployment network controls, monitoring, and regular security review.

## Roadmap

Production work is tracked in issue #10. The next implementation phase is campaign workspace tools and controlled AI tool calls, followed by the encounter engine, Discord integration, session intelligence, authorized retrieval, advanced VTT maps, and evaluations/cost controls.

Voice Co-DM remains deferred as a separate possible premium feature.
