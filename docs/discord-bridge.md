# Discord Bot Core Bridge

Khaos Nexus AI does not run a Discord Gateway client and does not store a bot token. The existing Khaos Nexus Discord Bot Core calls this service over HTTP after the Discord user links their Khaos Nexus account.

## Identity flow

1. The Discord user links or signs into Khaos Nexus through Supabase Auth.
2. The active `dnd_campaign_members` row stores both the Supabase `user_id` and Discord `discord_user_id`.
3. Bot Core forwards the linked user's Supabase access token in `Authorization: Bearer ...`.
4. The command request includes the registered app ID, guild ID, bound channel/thread/post ID, and Discord actor ID.
5. PostgreSQL resolves an active, verified `dnd_discord_bindings` row and requires:
   - the registered app is enabled;
   - guild and resource IDs match;
   - the binding is active and verified;
   - `auth.uid()` matches the active campaign member;
   - the campaign member's `discord_user_id` matches the Discord actor.
6. Existing campaign, workspace-tool, encounter-tool, and homebrew authorization remains authoritative.

A bot token, service-role key, or shared database-bypass credential is never sent to this service.

## Existing-resource rule

Bindings may target only an existing Discord channel, thread, or forum post. The AI service does not create categories, channels, threads, roles, or webhooks.

Supported purposes:

- `main`
- `dm_private`
- `dice_log`
- `character_chat`
- `session_notes`
- `loot`
- `announcements`

Voice-purpose bindings are explicitly rejected. Voice Co-DM remains deferred as a possible premium feature.

## Binding management

Authenticated campaign and registered-app managers use:

```http
GET /api/v1/campaigns/:campaignId/discord/bindings
POST /api/v1/campaigns/:campaignId/discord/bindings
POST /api/v1/campaigns/:campaignId/discord/bindings/:bindingId/verify
```

Creating or changing a binding clears verification. Bot Core should confirm the app can read and respond in the resource, then call the verification endpoint using the linked manager's access token.

## Command bridge

Discovery:

```http
GET /api/v1/discord/commands
```

Execution:

```http
POST /api/v1/discord/commands
Authorization: Bearer <linked-user-access-token>
Content-Type: application/json
```

Example:

```json
{
  "registeredAppId": "00000000-0000-4000-8000-000000000000",
  "guildId": "123456789012345678",
  "resourceId": "223456789012345678",
  "discordUserId": "323456789012345678",
  "command": "roll",
  "options": {
    "notation": "2d20kh1+5"
  }
}
```

Supported commands:

- `campaign_status`
- `roll`
- `homebrew`
- `approve_homebrew`
- `map`
- `encounter_state`
- `workspace_tool`
- `encounter_tool`

The response is Discord-neutral JSON:

```json
{
  "discord": {
    "content": "2d20kh1+5: **24**",
    "ephemeral": false,
    "embeds": [],
    "data": {}
  },
  "context": {
    "campaignId": "...",
    "member": { "role": "player" },
    "canManage": false
  }
}
```

Bot Core is responsible only for translating this payload into Discord replies, embeds, buttons, or modals.

## Permission behavior

- Read commands receive database-filtered campaign or encounter state.
- Workspace mutations remain manager-only through the Phase 2 RPC.
- Encounter mutations use the Phase 3 manager/player-owned combatant rules.
- Homebrew approval requires campaign-management permission.
- Unverified or unbound channels are rejected.
- Disabled registered apps are rejected.
- A user cannot substitute another Discord actor ID because the database matches it to `auth.uid()`.

## Deployment activation

The Khaos Nexus database currently contains the bridge schema and RPCs, but command traffic becomes active only after:

1. the shared Khaos Nexus bot is registered in `discord_registered_apps`;
2. authorized app managers are assigned;
3. campaign members have linked Discord user IDs;
4. managers bind and verify existing resources;
5. Bot Core forwards linked-user Supabase access tokens.
