# Session Intelligence

Session Intelligence converts session notes and transcript excerpts into a structured, manager-reviewed campaign artifact. It does not automatically change campaign canon, entities, quests, loot, encounters, or player state.

Voice Co-DM is outside this feature and remains deferred as a possible premium capability.

## Output

Each generated result contains:

- `gmRecap`: full manager-facing recap, including private material supplied to the generator
- `playerRecap`: spoiler-safe recap intended for players after approval
- `canonFacts`: proposed facts with confidence, source evidence, and a public/private flag
- `contradictions`: claims that conflict with established campaign information
- `unresolvedThreads`: new, open, or resolved story threads
- `entityChanges`: reviewable NPC, location, faction, quest, loot, or campaign proposals
- `nextSessionPrep`: opening scene, likely NPCs, encounter ideas, clues, risks, and questions

Generation preserves player agency and must not invent unsupported choices, rolls, dialogue, or outcomes.

## Review boundary

Generation and mutation are separate operations.

1. A manager generates intelligence from session material.
2. The generated result is returned without persistence.
3. A manager may save it as a new revision.
4. Saving increments `intelligence_revision` and clears any earlier approval.
5. A manager may approve that exact revision.
6. Proposed canon or entity changes remain proposals. Managers apply selected changes through the existing allow-listed campaign tools.

A stale revision cannot be saved or approved. Clients must reload the current session intelligence before retrying.

## Visibility

Managers receive:

- GM and player recaps
- source evidence
- contradictions
- private and public facts
- private and public threads
- entity-change proposals
- next-session preparation

Players and viewers receive nothing until a manager approves a revision. After approval, PostgreSQL rebuilds a minimal public projection containing only:

- session title
- player recap
- public canon fact statements and confidence
- public thread text and status

The public projection does not return GM recap text, source evidence, contradiction details, entity proposals, preparation notes, or private thread notes.

## HTTP API

```text
GET  /api/v1/campaigns/:campaignId/sessions/:sessionId/intelligence
POST /api/v1/campaigns/:campaignId/sessions/:sessionId/intelligence/generate
POST /api/v1/campaigns/:campaignId/sessions/:sessionId/intelligence/save
POST /api/v1/campaigns/:campaignId/sessions/:sessionId/intelligence/approve
```

Generate request:

```json
{
  "sourceNotes": "PUBLIC FACT: The crucible was damaged.\nPUBLIC THREAD: Repair the crucible.",
  "transcript": [
    {
      "speaker": "Vorkesh",
      "text": "I promise to repair it.",
      "public": true
    }
  ],
  "focus": ["continuity", "quest changes"],
  "includePrep": true
}
```

Save request:

```json
{
  "intelligence": { "version": 1 },
  "expectedRevision": 0
}
```

The abbreviated `intelligence` object above is illustrative; the real request must satisfy the complete strict result schema.

Approve request:

```json
{
  "expectedRevision": 1
}
```

`expectedRevision` is always required for save and approval operations.

## Discord bridge

The existing linked-user Discord bridge exposes:

- `session_intelligence`
- `generate_session_intelligence`
- `approve_session_intelligence`

Generation and approval require campaign-management permission. Read responses are filtered by the database role and approval state. Discord Bot Core remains responsible for transport and rendering.

## Persistence and auditing

The session row stores the current draft, revision, approval actor, approval timestamp, and intelligence update timestamp. Save and approval operations use row locks and write `dnd_audit_log` actions:

- `ai.session_intelligence.saved`
- `ai.session_intelligence.approved`

The existing `recap_draft` and recap approval fields are synchronized with the player recap for compatibility with current campaign workspace clients.

## Provider behavior

Mock mode is deterministic and supports explicit note markers for tests and local development. OpenAI mode uses strict structured output through the Responses API and inherits the service-wide `store: false` policy.

No raw source notes are persisted by the generation endpoint. They become persistent only if a manager deliberately includes material in the validated intelligence result and saves it.
