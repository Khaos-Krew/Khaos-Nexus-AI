# Khaos Nexus AI

Khaos Nexus AI is the authenticated, headless D&D Game Master and Co-DM service for the Khaos Nexus ecosystem. It supports campaign state, controlled campaign tools, encounter and initiative tracking, copyright-safe homebrew, procedural maps, dice, and Supabase/PostgreSQL persistence while remaining usable in offline local-development mode.

Voice Co-DM is intentionally deferred. It may be evaluated later as a premium feature after authorization, campaign workflows, usage budgets, and cost controls are mature.

## Included

- Game Master and Co-DM campaign turns
- Local JSON persistence or caller-scoped Supabase/PostgreSQL persistence
- Supabase Auth bearer-token verification
- RLS-authorized campaign lists and role-filtered workspaces
- Transactional campaign creation and AI-state updates
- Eight strict campaign workspace tools
- Sixteen strict encounter and combat tools
- Initiative ordering, rounds, turns, HP, temporary HP, armor class, conditions, concentration, reactions, death saves, legendary actions, hidden combatants, and lair actors
- Audited homebrew creation and manager approval
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

Use a publishable key only. The service rejects values that resemble service-role or `sb_secret_` credentials. Every Data API request carries the caller's verified Supabase access token, keeping PostgreSQL authorization authoritative.

`/health` remains public; Supabase mode requires authentication for `/api/v1/*`.

## OpenAI mode

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5-mini
```

OpenAI requests use `store: false`. Keep keys server-side and outside browser bundles, desktop renderers, Discord payloads, and committed files.

## API routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Service, provider, persistence, and authentication status |
| `GET` | `/api/v1/me` | Verified user context |
| `GET` | `/api/v1/workspace-tools` | Discover campaign workspace tools |
| `GET` | `/api/v1/encounter-tools` | Discover encounter and combat tools |
| `GET` | `/api/v1/campaigns` | List campaigns visible to the caller |
| `GET` | `/api/v1/campaigns/:id` | Load AI-compatible campaign state |
| `GET` | `/api/v1/campaigns/:id/workspace` | Load role-filtered workspace data |
| `GET` | `/api/v1/campaigns/:id/encounters/:encounterId` | Load role-filtered encounter state |
| `POST` | `/api/v1/campaigns` | Create a campaign and initial characters |
| `POST` | `/api/v1/campaigns/:id/turns` | Generate, audit, and persist an AI turn |
| `POST` | `/api/v1/campaigns/:id/tools/execute` | Execute one validated workspace tool |
| `POST` | `/api/v1/campaigns/:id/encounters/tools/execute` | Execute one validated encounter tool |
| `POST` | `/api/v1/homebrew/generations` | Generate homebrew without persistence |
| `POST` | `/api/v1/campaigns/:id/homebrew/generations` | Generate and persist draft homebrew |
| `POST` | `/api/v1/campaigns/:id/homebrew/:homebrewId/approve` | Approve homebrew as a manager |
| `POST` | `/api/v1/maps/generations` | Generate structured map data and SVG |
| `POST` | `/api/v1/dice/rolls` | Roll validated dice notation |

## Controlled campaign workspace tools

Generation and execution are separate. An AI response or client can propose a tool call, but campaign data changes only after an authenticated caller explicitly invokes it.

Workspace tools:

- `upsert_npc`
- `upsert_location`
- `upsert_faction`
- `upsert_quest`
- `upsert_loot`
- `upsert_session`
- `approve_session_recap`
- `upsert_calendar_event`

Each tool has a strict argument schema. Unknown tool names and undeclared fields are rejected. The matching database RPC uses static control flow, not dynamic SQL.

## Encounter and initiative engine

Encounter tools:

- `create_encounter`
- `set_encounter_status`
- `add_combatant`
- `set_initiative`
- `advance_turn`
- `rewind_turn`
- `apply_damage`
- `heal`
- `set_combatant_stats`
- `add_condition`
- `remove_condition`
- `set_concentration`
- `set_reaction`
- `record_death_save`
- `set_legendary_actions`
- `set_combatant_visibility`

The initiative order is deterministic: initiative descending, dexterity descending, join time, then combatant ID. Advancing past the final active combatant increments the round. Entering a combatant's turn restores that combatant's reaction and legendary-action allowance.

Damage consumes temporary HP before normal HP. Healing cannot exceed maximum HP. Conditions can store optional duration/source details. Concentration, reactions, death saves, hidden state, active state, legendary actions, and lair actors are explicit fields rather than unstructured notes.

Example:

```bash
curl -X POST \
  http://localhost:8787/api/v1/campaigns/CAMPAIGN_ID/encounters/tools/execute \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "apply_damage",
    "arguments": {
      "combatantId": "00000000-0000-4000-8000-000000000000",
      "amount": 8,
      "damageType": "fire",
      "source": "Arcane vent"
    }
  }'
```

### Encounter permissions

Campaign managers control encounter lifecycle, initiative, damage, healing, conditions, enemy state, visibility, and legendary actions.

Players may update only combatants backed by characters they own, and only for:

- `set_concentration`
- `set_reaction`
- `record_death_save`

Hidden combatants and private encounter metadata are removed from non-manager state responses inside PostgreSQL. Every successful mutation writes a `dnd_audit_log` event.

## Campaign visibility and approvals

Players and viewers receive only role-appropriate workspace data, including revealed entities, visible quests, permitted loot, approved recaps, non-hidden encounter information, approved homebrew, and their own drafts.

GM notes, hidden metadata, private AI state, unapproved recaps, and hidden combatants are filtered inside PostgreSQL rather than hidden by clients.

## Homebrew copyright boundary

- Use original concepts, summaries, high-level mechanics, licensed notes, public-domain material, or genuinely short excerpts.
- Exact-copy, verbatim, full-text, and reconstruction requests are rejected before provider invocation.
- Raw inspiration is not persisted by generation endpoints.
- Output includes provenance labels, transformed signals, balance guidance, and an originality assessment.
- Only campaign managers may approve homebrew.

These controls reduce copying risk but are not legal advice.

## Map generation

Supported map types are `encounter`, `dungeon`, `settlement`, `region`, and `travel`. Responses include validated structured data plus an SVG preview. Identical complete requests and seeds produce identical maps in procedural/mock mode.

Requests to copy or reconstruct published commercial maps are rejected before generation.

## Architecture

```text
Windows / Discord / web clients
              |
       Supabase Auth JWT
              |
              v
       Khaos Nexus AI API
       /         |          \
 Campaigns   Encounters    Generators
      |           |          /      \
      v           v       Homebrew   Maps
 Authenticated Supabase RPC       AI provider
              |
      PostgreSQL roles + audit
```

- `src/app.js` owns routing, authentication gates, and orchestration.
- `src/workspace-tools.js` owns campaign-tool contracts.
- `src/encounter-tools.js` owns encounter-tool contracts.
- `src/encounter-engine.js` provides deterministic local combat behavior.
- `src/supabase.js` owns Auth verification and caller-scoped RPC requests.
- `src/store.js` owns local campaign persistence.
- `src/domain.js`, `src/homebrew.js`, `src/maps.js`, `src/ai.js`, and `src/dice.js` own their respective contracts and engines.

## Database migrations

Phase 1 adds authentication-oriented RPCs, filtered workspaces, transactional campaign state, homebrew approval, policy corrections, and indexes.

Phase 2 adds the audited, manager-only workspace-tool RPC.

Phase 3 adds explicit combat-state columns, filtered encounter state, transaction-safe encounter mutations, player-owned self-state permissions, and combat audit events.

Privileged implementations live in the non-exposed `private` schema. Narrow public wrappers are authenticated-only, and anonymous execute permissions are revoked.

## Validate

```bash
npm ci
npm test
npm run build
```

Review Supabase security and performance advisors after database changes. Newly added indexes may appear as unused until real encounter traffic exists; do not remove them solely because they are unused immediately after deployment.

## Security baseline

- No database-bypass key is accepted by the application.
- User access tokens are verified before protected routes run.
- Data API calls carry the caller's JWT.
- Workspace and encounter tools are allow-listed in both JavaScript and PostgreSQL.
- Encounter mutations use row locks and write audit events.
- Hidden combatants and private metadata are filtered in the database.
- Request bodies are size-limited, validated, rate-limited, and served with defensive headers.
- OpenAI requests use `store: false`.
- Copyright checks execute before AI provider invocation.

## Roadmap

Production work is tracked in Issue #10. Phases 1–3 establish authentication, persistence, visibility, approvals, campaign tools, and combat state. Remaining phases cover Discord integration, session intelligence, authorized retrieval, advanced VTT maps, and evaluations/cost controls.

Voice Co-DM remains deferred as a separate possible premium feature.
