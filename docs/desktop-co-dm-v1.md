# Khaos Nexus desktop Co-DM API v1

The desktop Co-DM endpoint is a stateless, review-only generation contract. Khaos Nexus desktop selects and redacts campaign context, asks the user to initiate generation, displays the returned draft locally, and owns every explicit copy/save action.

The AI service does not create a campaign, append a transcript, execute tools, post to Discord, or apply proposed changes for this endpoint.

## Capability

`GET /health` includes:

```json
"dnd.co-dm.draft"
```

The package version implementing the dedicated contract is `0.11.0`.

## Route

`POST /api/v1/dnd/co-dm/drafts`

Required headers:

- `Content-Type: application/json`
- `X-Khaos-Request-Id: <UUID>`
- `Authorization: Bearer <access token>` when service authentication is enabled

The header request ID must match the body request ID. It is used by the production-control ledger for correlation and duplicate-charge protection.

## Workflows

- `session_prep`
- `session_recap`
- `encounter_review`
- `npc_dialogue`
- `world_hooks`
- `rules_research`

## Request

```json
{
  "apiVersion": "1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "workflow": "session_prep",
  "model": "default",
  "prompt": "Prepare the next session.",
  "context": {
    "campaignId": "desktop-local-opaque-id",
    "campaignName": "Emberfall",
    "characters": 12000,
    "sections": [
      {
        "id": "characters",
        "label": "Characters",
        "count": 4,
        "reason": "included"
      }
    ],
    "text": "Bounded, redacted, untrusted campaign reference text."
  },
  "limits": {
    "maxOutputCharacters": 40000
  },
  "policy": {
    "explicitUserAction": true,
    "autonomousActionsAllowed": false,
    "providerStorageAllowed": false,
    "toolsAllowed": false,
    "licensedFullTextProvided": false
  }
}
```

`model` must be `default`; provider and model selection remain server-owned. Unknown fields are rejected.

`context.text` is limited to 120,000 characters, `prompt` to 12,000 characters, at most 50 context-section summaries may be supplied, and the complete HTTP body is limited to 256 KiB.

The service requires:

- explicit user initiation
- no autonomous actions
- no provider-side storage
- no provider tools

Context text is treated as untrusted reference data and cannot override service instructions.

## Response

```json
{
  "apiVersion": "1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "draft": {
    "content": "Generated review draft",
    "model": "openai/gpt-5-mini",
    "workflow": "session_prep"
  },
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0
  }
}
```

Usage values are populated when the provider supplies them. The draft is bounded by `maxOutputCharacters`.

## Errors

Errors use a stable envelope:

```json
{
  "apiVersion": "1",
  "requestId": "uuid",
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Safe user-facing message",
    "retryable": false
  }
}
```

Codes:

- `INVALID_REQUEST`
- `AUTH_REQUIRED`
- `REQUEST_TOO_LARGE`
- `RATE_LIMITED`
- `SERVICE_UNAVAILABLE`
- `GENERATION_FAILED`
- `METHOD_NOT_ALLOWED`

Provider credentials and raw provider errors are never included.

## Production controls

The endpoint uses feature `co_dm.draft` under prompt contract:

- prompt ID: `dnd-co-dm-draft`
- prompt version: `1`
- prompt hash: `fce64509f922302feafadd7a74e8cd741fa52376c9bee3eefce1770fbc9c110a`
- policy version: `baseline-1`

It shares Phase 8 model allow-lists, token/output limits, tenant/user/feature budgets, usage accounting, latency/error monitoring, copyright checks, player-agency checks, and secret-leakage evaluation.

OpenAI requests continue to use `store: false`. No Voice Co-DM capability is included.
