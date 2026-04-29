# ADR 0003: Prisma as metadata cache, not a content mirror

## Status

Accepted (Arch-X.d)

## Context

Tables such as mirror ownership maps and denormalized counts duplicated information already implied by Jellyfin and scanning pipelines. They increased migration cost and encouraged incorrect “source of truth” in SQL.

## Decision

- **Remove** mirror-style tables and fields that duplicated Jellyfin-derived ownership or location (`Album.location`, ownership facts, etc.) where Jellyfin is the library.
- Keep **Prisma** for: users, sessions, plays, favorites, discovery, enrichment caches (e.g. artist bios), `SavedDiscoveryAlbum`, and other app-owned aggregates.

## Consequences

- “Owned” in the UI is resolved from Jellyfin (or fused APIs), not from dropped mirror tables.
- Any feature that still reads removed columns must be ported to Jellyfin-first queries or dropped.
- Database size and backfill complexity shrink; fewer cross-table consistency bugs.
