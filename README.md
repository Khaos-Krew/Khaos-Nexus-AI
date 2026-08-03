# Khaos Nexus AI

A runnable D&D-focused AI Game Master and Co-DM service for the Khaos Nexus ecosystem.

This repository contains the shared AI core. It is intentionally headless so the same campaign engine can later support the Khaos Nexus Windows app, Discord campaign channels, and administrative tools without duplicating prompts, campaign memory, or safety logic.

## Current MVP

- Game Master and Co-DM campaign modes
- Persistent local campaign state
- Structured AI turns containing narration, dialogue, suggested checks, choices, state updates, and safety status
- OpenAI Responses API integration with strict JSON-schema output
- Deterministic mock provider for development and testing without an API key
- D&D-style dice notation including `1d20+5`, `2d20kh1+3`, and `2d20kl1`
- Campaign lines, veils, content rating, and pause words
- User-supplied lore and rules notes
- Zero runtime dependencies, REST API, validation, rate limiting, security headers, tests, Docker, and CI

The service does **not** bundle proprietary D&D books or attempt to reconstruct copyrighted rulebook text. Add only content that you have the right to use, such as your own campaign notes, homebrew, and appropriately licensed rules material.

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
| `POST` | `/api/v1/dice/rolls` | Roll validated dice notation |

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
```

Key boundaries:

- `src/app.js` owns HTTP behavior and campaign orchestration.
- `src/domain.js` owns validated campaign and turn contracts.
- `src/ai.js` owns provider abstraction, prompt policy, and structured model output.
- `src/store.js` owns persistence behind an interface.
- `src/dice.js` owns deterministic, testable dice parsing and rolling.

The JSON store is suitable for local development and single-instance evaluation. A production Khaos Nexus deployment should replace it with the planned Supabase/PostgreSQL adapter, row-level access controls, audit logging, and encrypted secret management.

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
- Request bodies are limited and validated.
- API requests are rate-limited and receive defensive HTTP headers.
- The model must preserve player agency and honor configured safety boundaries.
- Authentication is not yet implemented; do not expose this MVP directly to the public internet.

## Planned production follow-ups

1. Supabase/PostgreSQL campaign and transcript persistence with RLS.
2. Discord channel binding and permission-aware commands.
3. Windows desktop campaign workspace and streaming responses.
4. Authentication, tenancy, audit events, and usage budgets.
5. Retrieval over user-authorized SRD, campaign, and homebrew documents.
6. Initiative, encounter, NPC, quest, inventory, and session-summary tools.
7. Voice narration and accessibility settings.

Tracked by issue #1.
