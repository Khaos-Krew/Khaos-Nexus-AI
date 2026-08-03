# Khaos Nexus AI

A runnable D&D-focused AI Game Master and Co-DM service for the Khaos Nexus ecosystem.

The service is headless so the same campaign engine can later power the Windows desktop app, Discord campaign channels, and administrative tools without duplicating prompts, campaign state, safety logic, homebrew policy, or map generation.

## Included

- Game Master and Co-DM campaign modes
- Persistent local campaign state and transcripts
- Structured AI turns with narration, dialogue, checks, choices, and state updates
- Copyright-safe original homebrew generation
- Procedural and AI-assisted D&D map generation
- Seeded, reproducible map layouts with SVG previews
- D&D dice notation such as `1d20+5`, `2d20kh1+3`, and `2d20kl1`
- Lines, veils, content ratings, and pause words
- OpenAI Responses API structured output and deterministic offline mock mode
- Zero runtime dependencies, Docker, tests, and GitHub Actions CI

## Requirements

- Node.js 22 or newer
- npm
- An OpenAI API key only when using the OpenAI provider

## Start locally

```bash
cp .env.example .env
npm ci
npm start
```

The default `AI_PROVIDER=mock` runs without an API key. Open `http://localhost:8787/health` to verify the service.

For OpenAI mode, provide environment variables through your shell or deployment platform:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5-mini
```

Keep API keys server-side. Do not expose them in a browser, desktop renderer, Discord payload, or committed `.env` file.

## API routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Service and provider status |
| `GET` | `/api/v1/campaigns` | List campaigns |
| `GET` | `/api/v1/campaigns/:id` | Load campaign state |
| `POST` | `/api/v1/campaigns` | Create a campaign |
| `POST` | `/api/v1/campaigns/:id/turns` | Generate and persist an AI turn |
| `POST` | `/api/v1/homebrew/generations` | Generate original homebrew |
| `POST` | `/api/v1/maps/generations` | Generate structured map data and SVG |
| `POST` | `/api/v1/dice/rolls` | Roll validated dice notation |

## Create a campaign

```bash
curl -X POST http://localhost:8787/api/v1/campaigns \
  -H "Content-Type: application/json" \
  -d '{
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

## Generate original homebrew

```bash
curl -X POST http://localhost:8787/api/v1/homebrew/generations \
  -H "Content-Type: application/json" \
  -d '{
    "contentType": "subclass",
    "titleHint": "Ashen Mechanist",
    "concept": "An artificer path that channels heat through crafted armor and chooses between shielding allies or overcharging tools.",
    "targetTier": "mid",
    "powerLevel": "standard",
    "constraints": ["Avoid permanent flight", "Use proficiency bonus scaling"],
    "inspirations": [
      {
        "label": "Fire-themed character option",
        "authorization": "summary-only",
        "confirmedRightToUse": true,
        "summary": "The broad appeal is controlled elemental risk and a visible heat meter. Do not reuse names, text, or feature progression.",
        "designSignals": ["heat as a resource", "risk versus protection"]
      }
    ]
  }'
```

Supported types are `subclass`, `species`, `feat`, `spell`, `item`, `monster`, `background`, `encounter`, and `setting-element`.

### Homebrew copyright boundary

- Use your own concepts, summaries, high-level mechanics, licensed notes, public-domain material, or genuinely short excerpts.
- `short-excerpt` inspiration is capped at 700 characters per entry.
- Other inspiration summaries are capped at 1,800 characters per entry and 6,000 characters total.
- Exact-copy, verbatim, full-text, and reconstruction requests are rejected before any model call.
- Raw inspiration is not persisted by the MVP endpoint.
- Output includes transformed design signals, balance guidance, provenance labels, and an originality assessment.

These controls reduce copying risk but are not legal advice.

## Generate a map

```bash
curl -X POST http://localhost:8787/api/v1/maps/generations \
  -H "Content-Type: application/json" \
  -d '{
    "mapType": "dungeon",
    "prompt": "A ruined dragon forge with two routes to a central crucible and unstable arcane vents.",
    "seed": "emberforge-001",
    "width": 32,
    "height": 24,
    "gridType": "square",
    "density": "standard",
    "theme": "dark",
    "features": ["central crucible", "collapsed workshop", "secret cooling tunnel"]
  }'
```

Supported map types are encounter, dungeon, settlement, region, and travel. Responses include validated structured data plus a locally rendered SVG preview. The same complete request and seed produce the same result in mock/procedural mode.

Map output includes:

- Grid dimensions and scale
- Rooms, zones, terrain, and routes
- Points of interest and secret locations
- Encounters, hazards, entrances, and exits
- GM notes and originality status
- SVG themes: parchment, blueprint, dark, and minimal

Requests to copy or reconstruct published commercial maps are rejected before generation.

## Architecture

```text
Windows / Discord / web clients
              |
              v
          Node REST API
        /        |        \
 Campaigns   Homebrew    Maps
      |           \        /
      v            AI Provider
 JSON store       mock | OpenAI
```

- `src/app.js` owns HTTP behavior and orchestration.
- `src/domain.js` owns campaign and turn validation.
- `src/homebrew.js` owns homebrew policy and contracts.
- `src/maps.js` owns map validation, procedural generation, and SVG rendering.
- `src/ai.js` owns provider abstraction and structured model output.
- `src/store.js` owns campaign persistence.
- `src/dice.js` owns dice parsing and rolling.

## Validate

```bash
npm ci
npm test
npm run build
```

## Docker

```bash
docker build -t khaos-nexus-ai .
docker run --rm -p 8787:8787 \
  -e AI_PROVIDER=mock \
  -v khaos-nexus-ai-data:/app/data \
  khaos-nexus-ai
```

## Security baseline

- OpenAI requests use `store: false`.
- Campaign file writes are atomic and owner-only.
- Request bodies are size-limited and validated.
- Requests are rate-limited and receive defensive HTTP headers.
- Copyright-policy checks execute before provider invocation.
- Secret map points are excluded from player-facing SVG previews.
- Authentication is not implemented yet; do not expose this MVP directly to the public internet.

## Production follow-ups

- Supabase/PostgreSQL persistence with RLS and audit events
- Authentication, tenancy, and usage budgets
- Windows campaign, homebrew, and map workspaces
- Discord channel binding and permission-aware commands
- VTT export, fog of war, tokens, and collaborative map editing
- Initiative, encounters, NPCs, quests, inventories, and session summaries
- Voice narration and accessibility settings

Tracked by issues #1, #3, #4, and #8.
