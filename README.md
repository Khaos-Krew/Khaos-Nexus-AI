# Khaos Nexus AI

A runnable D&D-focused AI Game Master, Co-DM, and procedural map service for the Khaos Nexus ecosystem.

This repository contains the shared AI core. It is intentionally headless so the same campaign engine can later support the Khaos Nexus Windows app, Discord campaign channels, VTT exports, and administrative tools without duplicating prompts, campaign memory, map logic, or safety rules.

## Current MVP

- Game Master and Co-DM campaign modes
- Persistent local campaign state
- Structured AI turns containing narration, dialogue, suggested checks, choices, state updates, and safety status
- Seeded encounter, dungeon, settlement, region, and travel map generation
- Machine-readable zones, routes, points of interest, encounters, hazards, exits, and GM notes
- Locally rendered SVG map previews with square, hex, or no grid
- OpenAI Responses API integration with strict JSON-schema output
- Deterministic mock provider for development and testing without an API key
- D&D-style dice notation including `1d20+5`, `2d20kh1+3`, and `2d20kl1`
- Campaign lines, veils, content rating, and pause words
- User-supplied lore and rules notes
- Zero runtime dependencies, REST API, validation, rate limiting, security headers, tests, Docker, and CI

The service does **not** bundle proprietary D&D books, adventure maps, or commercial cartography. Requests to copy, trace, or reconstruct an exact published map are rejected before generation. Describe the desired terrain, encounter goals, atmosphere, routes, and landmarks to produce a new original layout.

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

The default `AI_PROVIDER=mock` starts a fully functional local development service without calling an external model. Node does not load `.env` automatically; export the variables in your shell or use your deployment platform's environment settings.

Open `http://localhost:8787/health` to verify it is running.

For auto-reload during development:

```bash
npm run dev
```

## Use OpenAI

Set the following environment variables before starting the service:

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5-mini
```

API keys must remain server-side. Never commit `.env` or expose the key in a desktop renderer, browser client, or Discord command payload.

## API

### Create a campaign

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
    "lore": ["The Ashen Crucible was sealed after the last dragon war."],
    "rulesNotes": ["Use milestone advancement."],
    "safety": {
      "lines": ["Sexual violence"],
      "veils": ["Graphic torture"],
      "pauseWords": ["pause", "red card"]
    }
  }'
```

### Advance a campaign turn

```bash
curl -X POST http://localhost:8787/api/v1/campaigns/CAMPAIGN_ID/turns \
  -H "Content-Type: application/json" \
  -d '{
    "actor": "Vorkesh",
    "message": "I inspect the ruined forge for hidden runes.",
    "dmGuidance": "Foreshadow the Ember Vault without revealing its location."
  }'
```

### Generate a map

```bash
curl -X POST http://localhost:8787/api/v1/maps/generations \
  -H "Content-Type: application/json" \
  -d '{
    "mapType": "dungeon",
    "prompt": "A ruined dragon forge with a central crucible, two alternate approaches, and unstable arcane vents.",
    "seed": "emberforge-001",
    "width": 32,
    "height": 24,
    "gridType": "square",
    "density": "standard",
    "theme": "dark",
    "features": ["central crucible", "collapsed workshop", "secret cooling tunnel"],
    "constraints": ["At least two routes toward the objective"]
  }'
```

Supported map types are `encounter`, `dungeon`, `settlement`, `region`, and `travel`. Grid types are `square`, `hex`, and `none`. SVG themes are `parchment`, `blueprint`, `dark`, and `minimal`.

The response contains:

- `result`: structured map data suitable for editing, persistence, or later VTT conversion
- `svg`: an accessible inline SVG preview generated locally from the validated map data
- `meta.seed`: the seed needed to reproduce the layout

Using the same complete request and seed with the deterministic mock provider returns the same structured layout and SVG.

### Roll dice

```bash
curl -X POST http://localhost:8787/api/v1/dice/rolls \
  -H "Content-Type: application/json" \
  -d '{"notation":"2d20kh1+5"}'
```

### Routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/health` | Service and provider status |
| `GET` | `/api/v1/campaigns` | List campaigns |
| `GET` | `/api/v1/campaigns/:id` | Load campaign state |
| `POST` | `/api/v1/campaigns` | Create campaign |
| `POST` | `/api/v1/campaigns/:id/turns` | Generate and persist one AI turn |
| `POST` | `/api/v1/maps/generations` | Generate original structured map data and an SVG preview |
| `POST` | `/api/v1/dice/rolls` | Roll validated dice notation |

## Map model

Every generated map includes:

- Grid dimensions, grid type, and scale
- Rectangular zones with stable ids and bounded coordinates
- Connections between existing zones
- Visible and secret points of interest
- Encounter suggestions and environmental hazards tied to zones
- Entrances and exits
- GM notes and an originality review

The SVG is a preview rather than the source of truth. Clients should save and edit the structured map result, then rerender or convert it as needed. Secret points of interest are intentionally omitted from the player-facing SVG preview.

## Architecture

```text
Client (Windows / Discord / web)
              |
              v
          Node REST API
          |         |
          v         v
 Campaign Store   AI Provider
  JSON MVP        mock | OpenAI
                     |
                     v
             Validated map data
                     |
                     v
               SVG renderer
```

Key boundaries:

- `src/app.js` owns HTTP behavior and campaign orchestration.
- `src/domain.js` owns validated campaign and turn contracts.
- `src/maps.js` owns map request policy, deterministic procedural generation, validation, and SVG rendering.
- `src/ai.js` owns provider abstraction, prompt policy, and structured model output.
- `src/store.js` owns persistence behind an interface.
- `src/dice.js` owns deterministic, testable dice parsing and rolling.

The JSON store is suitable for local development and single-instance evaluation. Generated maps are returned but not persisted by this feature branch. Production storage should use the planned Supabase/PostgreSQL adapter with campaign ownership, revision history, and audit events.

## Validation

```bash
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

## Security and safety baseline

- External API keys stay on the server.
- OpenAI requests use `store: false`.
- Campaign writes are atomic and local files use owner-only permissions.
- Map coordinates, dimensions, and cross-references are validated before rendering.
- SVG labels and descriptions are XML-escaped before insertion.
- Published-map reconstruction requests are rejected before provider invocation.
- Request bodies are limited and validated.
- API requests are rate-limited and receive defensive HTTP headers.
- Authentication is not yet implemented; do not expose this MVP directly to the public internet.

## Planned production follow-ups

1. Supabase/PostgreSQL campaign, transcript, and map persistence with RLS and revision history.
2. Discord channel binding and permission-aware commands.
3. Windows desktop map editor with drag, resize, layers, fog of war, and streaming generation.
4. Authentication, tenancy, audit events, and usage budgets.
5. VTT exports such as Universal VTT, Foundry-compatible data, and printable PDF sheets.
6. Image-model rendering as an optional visual layer generated from the structured map.
7. Initiative, encounter, NPC, quest, inventory, and session-summary tools.
8. Voice narration and accessibility settings.

Tracked by issues #1 and #4.
