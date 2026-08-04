# Khaos Nexus desktop Co-DM API v1

The desktop Co-DM endpoint is a stateless, review-only contract. Khaos Nexus desktop selects/redacts context, requires explicit user initiation, displays the returned draft, and owns every later copy/save/apply action.

The endpoint does not create a campaign, append a transcript, execute tools, post to Discord, or apply proposed changes.

## Capability and compatibility

`GET /health` includes `dnd.co-dm.draft`.

Production app integration requires service `0.12.1` or newer. Production model selection is service-owned and pinned to `gpt-5-mini-2025-08-07`.

## Route

`POST /api/v1/dnd/co-dm/drafts`

Required headers:

- `Content-Type: application/json`
- `Authorization: Bearer <Supabase access token>`
- `X-Khaos-Tenant-Id: <authorized tenant UUID>`
- `X-Khaos-Request-Id: <UUID>`

The request-ID header must match the body request ID. It correlates UI, service monitoring, and duplicate-reservation protection.

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

`model` must be `default`; the client cannot select the provider/model. Unknown fields are rejected. `context.text` is limited to 120,000 characters, `prompt` to 12,000, context-section summaries to 50, and the HTTP body to 256 KiB.

Context is untrusted reference data and cannot override service instructions.

## Provider retention meaning

`providerStorageAllowed: false` is a required client/service policy: the service sends `store: false` and does not use conversations, files, background mode, or provider tools.

It does **not** promise Zero Data Retention. OpenAI project data controls govern provider-side abuse-monitoring retention. Operators must separately review/configure Modified Abuse Monitoring or Zero Data Retention when eligible. Product copy must not describe this endpoint as “zero retention” unless the deployed OpenAI project actually has ZDR enabled.

## Response

```json
{
  "apiVersion": "1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "draft": {
    "content": "Generated review draft",
    "model": "openai/gpt-5-mini-2025-08-07",
    "workflow": "session_prep"
  },
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0
  }
}
```

Provider usage is included when supplied. Output is bounded by `maxOutputCharacters`.

## Errors

Errors use a stable safe envelope with `code`, `message`, `retryable`, and `requestId`. Provider credentials, provider payloads, database details, and stack traces are not returned.

Expected codes include:

- `INVALID_REQUEST`
- `AUTH_REQUIRED`
- `REQUEST_TOO_LARGE`
- `RATE_LIMITED`
- `SERVICE_UNAVAILABLE`
- `GENERATION_FAILED`
- `METHOD_NOT_ALLOWED`

## Production controls

Feature: `co_dm.draft`

- prompt ID: `dnd-co-dm-draft`
- prompt version: `1`
- prompt hash: `fce64509f922302feafadd7a74e8cd741fa52376c9bee3eefce1770fbc9c110a`
- global model policy: `launch-2`

The endpoint shares model allow-lists, token/output limits, explicit tenant/user/feature budgets, idempotent usage accounting, latency/error monitoring, copyright checks, player-agency checks, and secret-leakage evaluation.

Voice Co-DM is not included.
