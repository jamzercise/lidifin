# ADR 0002: Audio analysis on `JellyfinTrackAnalysis`

## Status

Accepted (Arch-X.b)

## Context

Vibe mixes, mood features, and similar flows need loudness, tempo, and ML-derived fields. Those lived on the legacy `Track` model tied to local-file mirroring.

## Decision

- Persist Jellyfin-oriented analysis in **`JellyfinTrackAnalysis`**, keyed by `jellyfinTrackId` (`jellyfin:…` ids).
- The Python analyzer (and related jobs) write completion status and vectors there; TypeScript readers dispatch by id namespace (`jellyfin:` vs native cuids) where both still exist.

## Consequences

- No requirement to create a Prisma `Track` row to have analysis for a Jellyfin item.
- Migrations and cleanup jobs must treat analysis as **attached to Jellyfin identity**, not always to `Track.id`.
- Legacy local-library-only paths may still use `Track` analysis until fully retired.
