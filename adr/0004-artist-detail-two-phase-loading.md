# ADR 0004: Artist detail — Jellyfin-first response and phase-2 enrichment

## Status

Accepted (Arch-X.a.1, enrichment route)

## Context

Artist pages need fast hero + discography from the user’s library, plus heavier Last.fm / MusicBrainz / image data. Putting everything in one handler slowed the critical path and encouraged returning Last.fm track shapes that **overrode** Jellyfin-backed top tracks in the client.

## Decision

- **`GET /library/artists/:id`** returns Jellyfin-resolved identity, **owned** albums, and **top tracks** matched from Last.fm **against Jellyfin track titles** (playable `jellyfin:` ids).
- **`GET /library/artists/:id/enrichment`** returns bio, similar artists, discovery album suggestions, and supplementary images. The client merges enrichment **without** replacing server-owned top-track resolution.

## Consequences

- Frontend must treat enrichment as additive for album lists (with deduping by rgMbid/title), not as a second source of truth for popularity.
- Caching keys for Last.fm top tracks can evolve independently of enrichment caches.
- “PREVIEW”-style rows are minimized when the API filters to library-backed popular tracks.
