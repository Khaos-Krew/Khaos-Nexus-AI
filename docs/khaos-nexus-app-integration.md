# Khaos Nexus desktop integration

This document is the production handoff for connecting the Windows Electron application in `Khaos-Krew/Khaos-Nexus` to Khaos Nexus AI service `0.12.0` or newer.

## Boundary

The Electron **main process** owns all AI-service traffic. Renderer code must not receive:

- the OpenAI API key
- the AI service's deployment credentials
- unrestricted Supabase refresh/access-token storage
- raw provider errors
- direct production-control mutation access

The renderer sends a bounded user intent and redacted campaign context over an allow-listed IPC method. The main process obtains the current Supabase access token and active tenant ID, calls the AI service, then returns only the validated response or stable safe error.

The AI service remains authoritative for:

- provider and model selection
- OpenAI credentials and `store: false`
- tenant/campaign authorization through caller-scoped Supabase RPCs
- request, token, and configured-cost budgets
- model/prompt policies
- usage monitoring and evaluations
- provider and database error sanitization

## Integration artifact

Copy or adapt:

`integrations/khaos-nexus/ai-service-client.js`

The client has no external runtime dependencies and is intended for the Electron main process or another privileged Node process.

```js
import { KhaosNexusAiClient } from "./ai-service-client.js";

const ai = new KhaosNexusAiClient({
  baseUrl: settings.aiServiceUrl,
  getAccessToken: async () => supabaseSessionManager.requireAccessToken(),
  getTenantId: async () => workspaceContext.requireActiveTenantId(),
});

await ai.health();
```

`health()` requires:

- API version `1`
- service version `0.12.0` or newer
- capability `dnd.co-dm.draft`

Do not enable the AI UI when health compatibility fails.

## Required configuration

Store only the AI service URL in normal app configuration:

```text
AI service URL: https://<deployment-host>
```

The desktop must not store the OpenAI key. The service deployment stores that key server-side.

Local development may use `http://127.0.0.1:8787`. Non-local service URLs must use HTTPS.

## Request headers

Authenticated calls use:

```text
Authorization: Bearer <current Supabase access token>
X-Khaos-Request-Id: <UUID generated per user action>
```

Stateless generation also requires:

```text
X-Khaos-Tenant-Id: <active authorized tenant UUID>
```

Stateless endpoints currently include:

- `POST /api/v1/dnd/co-dm/drafts`
- `POST /api/v1/homebrew/generations`
- `POST /api/v1/maps/generations`

Campaign-scoped endpoints derive tenant ownership from the authorized campaign and do not depend on an arbitrary tenant selection.

## Co-DM flow

1. The user explicitly selects a Co-DM workflow and clicks Generate.
2. The renderer sends the main process only the workflow, prompt, selected context sections, local opaque campaign reference, character count, and privacy flags.
3. The main process redacts/excludes non-selected content.
4. The main process creates one UUID request ID.
5. The client sends the same request ID in the header and body.
6. The main process displays the returned draft for review.
7. Saving, copying, posting, or applying any draft requires a separate explicit user action.

The Co-DM request policy must remain:

```json
{
  "explicitUserAction": true,
  "autonomousActionsAllowed": false,
  "providerStorageAllowed": false,
  "toolsAllowed": false,
  "licensedFullTextProvided": false
}
```

Do not expose a renderer option that weakens these flags.

## Main-process IPC contract

Recommended allow-listed IPC methods:

- `ai:get-status`
- `ai:create-co-dm-draft`
- `ai:generate-homebrew`
- `ai:generate-map`
- `ai:generate-campaign-turn`
- `ai:generate-session-intelligence`

Each handler must:

- validate sender/frame origin using the existing desktop IPC policy
- validate exact input fields and size limits
- obtain the access token internally
- obtain the active tenant internally
- use one request ID for UI, service request, logs, and support correlation
- redact Authorization and tenant identifiers from normal logs
- return stable error fields only: `code`, `message`, `retryable`, `requestId`

Do not implement a generic `ai:request` or arbitrary URL/path IPC bridge.

## Capability gating

At application startup and after settings changes:

1. Call `health()`.
2. Cache only non-sensitive status fields for the session.
3. Disable AI controls if the service is unreachable, incompatible, or missing a capability.
4. Show a retry action rather than automatically sending generation requests.
5. Do not treat `/health` success as proof that the user has an active budget; generation can still return a policy/budget denial.

## Budget activation

The database now fails closed for OpenAI generation when no matching active tenant/campaign/user/feature budget exists.

Before owner testing:

1. Confirm the tenant exists and the owner/admin can manage it.
2. Create at least one bounded active budget through the production-control API or an approved admin surface.
3. Start with a conservative request/token/configured-cost limit.
4. Verify a permitted generation and a deliberate budget denial.
5. Keep billing/payment collection outside this integration; configured-cost limits are operational controls, not billing.

## Safe error handling

The client throws `KhaosNexusAiServiceError` with:

- `status`
- `code`
- `retryable`
- `requestId`

The desktop should display `message`, offer retry only when `retryable` is true, and include `requestId` in support details. Never display or log bearer tokens, provider payloads, database details, or stack traces.

## Release sequence

1. Deploy AI service `0.12.0` with production-required environment values.
2. Apply all Supabase migrations, including launch hardening.
3. Configure an active bounded budget for the owner-testing tenant.
4. Verify `/health` through the final HTTPS endpoint.
5. Implement the main-process client and strict IPC handlers in `Khaos-Krew/Khaos-Nexus`.
6. Add renderer status and explicit generation controls behind the D&D AI feature gate.
7. Test login expiry, tenant switching, budget denial, provider outage, service timeout, incompatible version, and normal generation.
8. Promote only after both repositories' release gates pass.

Voice Co-DM remains excluded.
