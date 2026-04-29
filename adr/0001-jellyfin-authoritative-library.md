# ADR 0001: Jellyfin as the authoritative music library

## Status

Accepted (Arch-X.a and follow-ups)

## Context

Lidifin originally mirrored library entities (albums, tracks, ownership) in PostgreSQL. That duplicated Jellyfin as a source of truth,complicated sync, and produced namespace bugs (native vs `jellyfin:` ids).

## Decision

For deployments that use Jellyfin as the music source:

- **Reads** for albums, artists, tracks, and streaming go to Jellyfin (and small Prisma caches where explicitly documented).
- **PostgreSQL** holds app state (users, plays, discovery batches, analysis rows keyed by Jellyfin ids), not a parallel copy of the whole music catalog for playback.

## Consequences

- Routes must branch on music source and avoid Prisma-first “library mirror” paths for Jellyfin mode.
- Features that assumed `Track` / `Album` rows for every song require redesign (e.g. mixes read analysis from `JellyfinTrackAnalysis`).
- Simpler mental model: Jellyfin owns files and metadata; Lidifin owns experience and derived data.
