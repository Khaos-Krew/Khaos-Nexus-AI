# Advanced map scenes

Phase 7 converts a validated structured map into an editable, versioned scene package suitable for Khaos Nexus clients and portable VTT adapters.

## Scene model

Each generated package contains two independently validated projections:

- `gmScene`: complete scene data, including GM notes, secrets, hidden tokens, hidden lights, unrevealed points of interest, and unrevealed fog regions.
- `playerScene`: the canonical filtered projection. It excludes GM notes, secret walls, secret doors, secret windows, hidden terrain, hidden lights, hidden tokens, unrevealed points of interest, and unrevealed fog geometry.

A client may not submit an arbitrary player package. The service rebuilds the expected player projection from the GM scene and rejects any mismatch. PostgreSQL independently rejects unsafe player packages.

Scene packages include:

- schema version and stable deterministic identifiers
- square, hex, or gridless configuration
- multiple levels with explicit elevation
- walls, doors, windows, terrain, and line-of-sight behavior
- lights with bright and dim radii
- fog-of-war reveal regions
- tokens and encounter references
- points of interest
- source-map SHA-256 identity

## Revision and approval workflow

1. Generate a draft scene package.
2. Save it with `expectedRevision: 0`.
3. Edit and resave using the exact current record ID and revision.
4. Approve the exact revision before players can read it.
5. Any subsequent save increments the revision and clears approval.

Managers can read GM and player projections. Players and viewers can read only approved player projections. Exports are manager-only.

## HTTP routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/v1/campaigns/:campaignId/map-scenes` | List visible scene records |
| `POST` | `/api/v1/campaigns/:campaignId/map-scenes/generate` | Generate GM/player scene packages and SVG previews |
| `POST` | `/api/v1/campaigns/:campaignId/map-scenes` | Save a new scene or exact revision |
| `GET` | `/api/v1/campaigns/:campaignId/map-scenes/:sceneId` | Read the role-filtered scene record |
| `POST` | `/api/v1/campaigns/:campaignId/map-scenes/:sceneId/approve` | Approve an exact revision |
| `POST` | `/api/v1/campaigns/:campaignId/map-scenes/:sceneId/export` | Produce a portable JSON export |

## Discord commands

- `generate_map_scene`
- `map_scene`
- `approve_map_scene`
- `export_map_scene`

These commands use the existing verified-channel, linked-user, and campaign-role context. Manager operations are ephemeral.

## Export targets

### `khaos_scene`

The complete Khaos Nexus scene contract with its requested GM or player projection.

### `universal_vtt_style`

A portable adapter containing map dimensions, line-of-sight segments, portals, lights, level metadata, and Khaos Nexus identifiers. It is intentionally described as Universal VTT-style rather than claiming compatibility with every implementation.

### `foundry_scene_data`

A portable Foundry-oriented scene-data object containing dimensions, grid information, walls, doors, lights, tokens, and Khaos Nexus flags. It does not authenticate to, upload into, or depend on a Foundry installation.

Every export includes:

- deterministic filename
- `application/json` content type
- target and projection
- SHA-256 payload hash
- revision in the filename

## Render manifest boundary

The service renders deterministic SVG previews locally. PNG and WebP production can consume the scene JSON or SVG through a future desktop renderer, but this repository does not add a browser, canvas, or image-model dependency.

## Security and scope boundaries

- No direct VTT account authentication or upload
- No proprietary VTT content ingestion
- No published-map reconstruction
- No browser editor UI in this repository
- No image-model map generation
- No voice functionality
