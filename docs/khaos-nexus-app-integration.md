# Khaos Nexus desktop integration

This is the production handoff for connecting `Khaos-Krew/Khaos-Nexus` to Khaos Nexus AI service `0.12.1` or newer.

## Security boundary

The Electron **main process** owns all AI-service traffic. Renderer code must never receive:

- the OpenAI API key
- AI deployment credentials
- unrestricted Supabase token storage
- raw provider or database errors
- arbitrary AI paths or production-control mutation access

The renderer sends an explicit user intent and selected/redacted campaign context through an allow-listed IPC method. The main process obtains the current Supabase access token and active tenant, calls the AI service, and returns only the validated response or stable safe error.

The AI service remains authoritative for provider/model selection, OpenAI credentials, caller-scoped authorization, budgets, model/prompt policies, usage monitoring, evaluations, and error sanitization.

## Provider and retention contract

Production is pinned to `gpt-5-mini-2025-08-07`; the desktop cannot select another model.

Every Responses API request sets `store: false` and this service does not use OpenAI conversations, files, background mode, or provider tools. This disables requested response-object storage for the service workflow, but it is **not a Zero Data Retention guarantee**. OpenAI project data controls govern provider-side abuse-monitoring retention. The operator must review the actual OpenAI project and separately enable Modified Abuse Monitoring or Zero Data Retention only when approved and operationally appropriate.

The desktop UI should describe this accurately. Do not label the service “zero retention” solely because `store: false` is set.

## Integration artifacts

- `integrations/khaos-nexus/ai-service-client.js`
- `integrations/khaos-nexus/integration-manifest.json`

The client has no external runtime dependencies and belongs in the Electron main process or another privileged Node boundary.

```js
import { KhaosNexusAiClient } from "./ai-service-client.js";

const ai = new KhaosNexusAiClient({
  baseUrl: settings.aiServiceUrl,
  getAccessToken: async () => supabaseSessionManager.requireAccessToken(),
  getTenantId: async () => workspaceContext.requireActiveTenantId(),
});

await ai.health();
```

`health()` requires API version `1`, service `0.12.1` or newer, and capability `dnd.co-dm.draft`. Keep AI controls disabled when compatibility fails.

## App configuration

Store only the AI service URL in normal app configuration:

```text
https://<deployment-host>
```

Local development may use `http://127.0.0.1:8787`. Non-local URLs must use HTTPS. The desktop must not store the OpenAI key.

## Request headers

Authenticated calls:

```text
Authorization: Bearer <current Supabase access token>
X-Khaos-Request-Id: <UUID generated per explicit user action>
```

Stateless generation also requires:

```text
X-Khaos-Tenant-Id: <active authorized tenant UUID>
```

Stateless paths:

- `POST /api/v1/dnd/co-dm/drafts`
- `POST /api/v1/homebrew/generations`
- `POST /api/v1/maps/generations`

Campaign-scoped paths derive tenant ownership from the authorized campaign.

## Co-DM flow

1. User selects a workflow and clicks Generate.
2. Renderer sends only the prompt, selected context summaries, redacted reference text, and required privacy flags.
3. Main process generates one request UUID.
4. Header and Co-DM body use the same UUID.
5. Service returns a review draft.
6. Copying, saving, posting, or applying the result requires another explicit user action.

Required policy:

```json
{
  "explicitUserAction": true,
  "autonomousActionsAllowed": false,
  "providerStorageAllowed": false,
  "toolsAllowed": false,
  "licensedFullTextProvided": false
}
```

`providerStorageAllowed: false` means the client refuses provider-persistence features and the service sends `store: false`; it does not override provider account retention controls.

## Allow-listed IPC

Recommended methods:

- `ai:get-status`
- `ai:create-co-dm-draft`
- `ai:generate-homebrew`
- `ai:generate-map`
- `ai:generate-campaign-turn`
- `ai:generate-session-intelligence`

Each handler validates sender/frame origin and exact fields, obtains token/tenant internally, correlates one request ID, redacts sensitive headers and IDs from routine logs, and returns only `code`, `message`, `retryable`, and `requestId` on failure.

Never implement a generic `ai:request`, arbitrary path proxy, renderer-held provider key, or renderer-controlled model selector.

## Budgets

OpenAI generation fails closed without a matching active tenant/campaign/user/feature budget. Before owner testing:

1. Confirm the owner-testing tenant and membership.
2. Create a conservative active request/token/configured-cost budget.
3. Verify one allowed request.
4. Verify a deliberate denial.
5. Restore the approved test limits.

Configured cost is an operational safety control, not billing.

## Release sequence

1. Deploy service `0.12.1` with the exact pinned snapshot and production environment contract.
2. Apply all Supabase migrations.
3. Review OpenAI project Data controls and document the selected retention setting.
4. Create the owner-testing tenant/budget.
5. Verify `/health` through the final HTTPS endpoint.
6. Implement the main-process client and strict IPC handlers in `Khaos-Krew/Khaos-Nexus` from the Production Control-assigned branch/commit.
7. Add renderer status and explicit generation controls behind the D&D AI feature gate.
8. Test token expiry, tenant switching, policy/budget denial, provider outage, timeout, incompatible version, service restart, and successful generation.
9. Promote only after both repositories pass release validation.

Voice Co-DM remains excluded.
