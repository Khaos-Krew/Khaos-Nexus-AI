# Authorized Campaign Retrieval

Authorized Retrieval searches only campaign-enabled material that the current user is permitted to see. It is not a book-import system, web crawler, chapter exporter, or source-text reconstruction tool.

Voice Co-DM is not part of this feature and remains deferred as a possible premium capability.

## Searchable material

A campaign search may return:

- entries from enabled `dnd_sources` and `dnd_content_entries` records;
- approved campaign homebrew, or manager-visible homebrew drafts for managers;
- approved player recaps, or manager-visible GM recaps for managers.

Every result includes a stable citation ID, source name, license type, content origin, attribution, external reference when available, and an excerpt of at most 700 characters.

Citation formats:

```text
source:<source-id>:entry:<entry-id>
homebrew:<homebrew-id>:revision:<revision>
session:<session-id>:intelligence:<revision>
```

## Source license classes

The existing source license model is used:

- `srd_cc_by`
- `user_authored`
- `user_supplied_private`
- `metadata_only`
- `external_link`
- `partner_api`
- `unknown_restricted`

SRD CC BY sources require attribution. External-link and partner sources require an HTTPS reference. Private or partner full-text sources require a rights or entitlement reference. Full text is accepted only for SRD CC BY, user-authored, user-supplied private, or authorized partner sources.

`metadata_only`, `external_link`, and `unknown_restricted` sources can store summaries and metadata but cannot store full text.

## Content origins

Entries retain one of these provenance labels:

- `metadata_only`
- `user_authored`
- `licensed_full_text`
- `licensed_summary`
- `public_domain`
- `partner_api`
- `external_reference`
- `campaign_generated`

Origin and source-license combinations are validated in both JavaScript and PostgreSQL. Partner API entries require partner sources. External-reference entries require external-link sources. Metadata-only entries cannot contain full text.

## Rights confirmation

The HTTP contract requires `confirmedRightToUse: true` whenever full text is submitted. This confirmation is validated before the database request. PostgreSQL independently enforces the source license, rights-reference, content-origin, size, and tenant rules.

The confirmation does not replace legal review and does not prove ownership. It prevents accidental ingestion without an explicit user assertion.

## Visibility

Sources can be:

- `manager_only`
- `campaign_members`

Entries can be:

- `inherit`
- `manager_only`
- `campaign_members`

Managers can search all enabled campaign sources. Players and viewers can search only campaign-member sources and entries whose effective visibility is campaign members. Hidden campaign content, manager-only sources, unapproved homebrew, GM recaps, GM notes, and private session intelligence do not enter player results.

Visibility filtering occurs in PostgreSQL for Supabase mode and is mirrored by the deterministic local adapter.

## Ingestion limits

- Source name: 240 characters
- Entry name: 300 characters
- Content type: 100 characters
- Summary: 4,000 characters
- Full text: 50,000 characters per entry
- Metadata: 12,000 serialized characters
- Search query: 3–500 characters
- Search results: 1–10
- Returned excerpt: at most 700 characters

Entries are hashed and deduplicated within a source. Search audit events store only a query hash, result count, and limit—not the raw query.

## Copyright boundary

The service rejects search prompts that request:

- verbatim or exact copies;
- full text;
- entire or whole books, chapters, modules, adventures, or sources;
- reconstruction or reproduction;
- page ranges;
- continuation from a previously extracted section.

The same safeguard exists in the HTTP/Discord validators and the PostgreSQL search RPC. Search has no offset or continuation cursor, preventing sequential extraction through the supported API.

## HTTP API

```text
GET  /api/v1/campaigns/:campaignId/retrieval/sources
POST /api/v1/campaigns/:campaignId/retrieval/sources
POST /api/v1/campaigns/:campaignId/retrieval/sources/:sourceId/entries
POST /api/v1/campaigns/:campaignId/retrieval/search
```

Source example:

```json
{
  "name": "Emberforge Campaign Notes",
  "ruleset": "D&D 5e-compatible",
  "licenseType": "user_authored",
  "fullTextAllowed": true,
  "confirmedRightToUse": true,
  "visibility": "campaign_members",
  "enabled": true
}
```

Entry example:

```json
{
  "contentType": "location",
  "name": "The Ember Vault",
  "summary": "A hidden vault beneath the lower forge.",
  "fullText": "User-authored campaign notes...",
  "contentOrigin": "user_authored",
  "visibility": "inherit",
  "confirmedRightToUse": true,
  "metadata": {}
}
```

Search example:

```json
{
  "query": "ancestral runes crucible",
  "limit": 5
}
```

## Discord bridge

The linked-user Discord bridge exposes:

```text
search_knowledge
```

Bot Core sends the same campaign-bound app, guild, resource, Discord actor, and linked Supabase access token used by the other D&D commands. The response contains compact excerpts and stable citation IDs for Bot Core to render.

## Database functions

Authenticated public wrappers:

- `dnd_ai_retrieval_sources`
- `dnd_ai_upsert_retrieval_source`
- `dnd_ai_upsert_retrieval_entry`
- `dnd_ai_search_retrieval`

Private implementations enforce campaign roles, tenant matching, source enablement, visibility, license rules, limits, citations, and auditing. Anonymous execution is revoked on both public and private functions.

## Deliberate exclusions

Phase 6 does not include:

- OpenAI-hosted vector stores;
- binary PDF or ebook upload pipelines;
- external website crawling;
- automated access to commercial books;
- page/chapter export;
- unrestricted full-text ingestion;
- answer generation that automatically loads every source;
- VTT or voice features.

Retrieval remains an explicit tool call with a small result and excerpt budget. A later application layer may use these cited results to ground AI answers, but it must preserve citations, authorization, and the no-reconstruction boundary.
