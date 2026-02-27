# Performance Audit – Research & Findings

This document consolidates research for Lidifin's performance audit (To Do #5). It identifies bottlenecks, documents current architecture, and proposes a prioritized improvement plan.

---

## 1. Executive Summary

**Problem**: App is slow, especially when loading library content. Need to identify unnecessary processes, workers, and inefficient operations.

**Key findings**:
- **Jellyfin mode**: Library data comes directly from Jellyfin API; no DB cache for artists/albums. Artist page triggers 15–30+ external API calls for enrichment.
- **Workers**: Multiple background workers run regardless of music source; several are Lidarr/Discovery-specific and may be unnecessary for Jellyfin-only deployments.
- **List endpoints**: 15s timeout; library list cache exists for Prisma mode but not for Jellyfin.
- **Frontend**: React Query caching is configured; no virtualization for large track lists.

---

## 2. Backend Workers – Inventory & Relevance

| Worker | Purpose | Jellyfin-Only Relevant? | Schedule |
|--------|---------|--------------------------|----------|
| **Unified Enrichment** | Artist metadata, track tags (Last.fm), queues audio analysis | Partial – artist enrichment used for Jellyfin artist pages | Continuous (BullMQ) |
| **Mood Bucket Worker** | Assigns analyzed tracks to mood buckets for mood mixes | No – requires local analyzed tracks | Continuous |
| **Library List Cache** | Precomputed owned-album IDs for GET /library/albums | **No** – only used when Prisma/DB is music source | Every 5 min |
| **Scan Queue** | Scans local music library | **No** – Jellyfin is external | On-demand |
| **Discover Queue** | Discover Weekly playlists | Optional – user feature | Sundays 8 PM |
| **Image Queue** | Image optimization | Partial – used for discovery/covers | On-demand |
| **Validation Queue** | Track validation | **No** – local library only | On-demand |
| **Data Integrity Check** | Cleans orphaned data, fixes mislocated albums | Partial – some checks apply to shared DB | Every 24h |
| **Reconciliation Cycle** | Lidarr download queue sync, stale job cleanup | **No** – Lidarr-specific | Every 2 min |
| **Lidarr Queue Cleanup** | Clears stuck Lidarr downloads | **No** – Lidarr-specific | Every 5 min |

**Recommendation**: Only disable Lidarr/Discovery workers when Lidarr is **not configured at all** (pure Jellyfin, no discovery or downloads). If you use **Lidarr + Jellyfin** for finding and downloading albums, **keep all Lidarr workers** – they are essential for that flow.

### Lidarr Workers – What They Do (Lidarr + Jellyfin setup)

When you use Lidarr with Jellyfin (e.g. Discover Weekly, "Add to Lidarr" from artist pages), these workers keep the download flow healthy:

1. **Reconciliation Cycle** (every 2 min):
   - **markStaleJobsAsFailed**: Jobs that have been "processing" too long (no webhook, timeout) → mark failed
   - **reconcileWithLidarr**: Check if albums you requested are now in Lidarr's artist/album list → mark completed (catches missed webhooks)
   - **reconcileWithLocalLibrary**: Fallback – check if albums exist in Lidifin's DB (e.g. from scanner) → mark completed
   - **syncWithLidarrQueue**: Detect if Lidarr cancelled or completed a download that Lidifin still thinks is "processing" → update state

2. **Lidarr Queue Cleanup** (every 5 min):
   - Finds failed/warning/stuck items in Lidarr's download queue
   - Removes them and triggers a new search for alternative releases
   - Prevents downloads from staying stuck indefinitely

3. **Queue Cleaner** (when download queue has active jobs):
   - Similar reconciliation logic, runs every 30s while queue is active
   - Stops when queue is empty to save resources

**Flow**: Discover Weekly or Add to Lidarr → Lidarr downloads → files land in your music path → Jellyfin scans that path → new albums appear in your library. The workers ensure Lidifin knows when downloads complete and keeps the queue healthy.

---

## 3. Database & Prisma

### Indexes
- Schema has extensive indexes on Artist, Album, Track, Playlist, DownloadJob, etc.
- Denormalized counts (`libraryAlbumCount`, `discoveryAlbumCount`, `totalTrackCount`) used for O(1) filtering on artists.
- Full-text search: `searchVector` (GIN) on Artist, Album, Track.

### Jellyfin Mode
- When Jellyfin is music source, `/library/artists`, `/library/albums`, `/library/tracks` bypass Prisma and call Jellyfin API directly.
- **Library list cache** (`libraryListCache.ts`) is **not used** for Jellyfin – it only caches Prisma-owned album IDs.
- Playlists, favorites, playback state, and user data still use Prisma.

### Potential N+1 / Slow Queries
- `getJellyfinArtistAlbumCounts`: Fetches album count per artist in parallel (concurrency 10). For 50 artists = 50 Jellyfin API calls (batched by concurrency).
- `resolveTrackReferences`: Batches of 50; sequential batches (not parallel). Per-item fallback on nulls can add many single-item calls.
- Mixes generation: Fetches all mixes, then loads tracks – could be heavy for large libraries.

---

## 4. Jellyfin API Usage

### Endpoints & Patterns

| Operation | Endpoint | Batch/Parallel | Notes |
|-----------|----------|----------------|--------|
| List artists | `/Users/{id}/Items?IncludeItemTypes=MusicArtist` | Single call | Paginated |
| List albums | `/Users/{id}/Items?IncludeItemTypes=MusicAlbum` | Single call | Paginated |
| Artist album count | `/Users/{id}/Items?ParentId={artistId}&IncludeItemTypes=MusicAlbum&Limit=1` | Per artist, parallel (10) | N calls for N artists |
| Resolve tracks | `/Users/{id}/Items?Ids=id1,id2,...` | Batches of 50, sequential | URL length limit |
| Playlist items | `/Playlists/{id}/Items` | Single call | Option A used for Jellyfin playlists |
| Favorites | Per-item or batch? | TBD | `getJellyfinFavorites` – check for batch support |

### Bottlenecks
1. **Artist list**: For each artist, `getJellyfinArtistAlbumCounts` does 1 call. 50 artists = 50 extra calls (throttled to 10 concurrent).
2. **resolveTrackReferences**: Sequential batches; 100 tracks = 2 sequential batch calls. Could parallelize batches.
3. **Artist page**: `enrichJellyfinArtist` does 15–30+ external calls (MusicBrainz, Last.fm, Fanart, Deezer) – see LOAD-TIME-IMPROVEMENT-PLAN.md.

---

## 5. Frontend

### React Query (useQueries.ts)
- **Stale times**: Artist 10m, Album 10m, Library 2m, Search 5m, Playlists 1m.
- **Prefetch**: `usePrefetchArtist` on artist link hover – album prefetch mentioned in LOAD-TIME-IMPROVEMENT-PLAN but may not be implemented.
- No `placeholderData` or skeleton for artist/album pages (full LoadingScreen).

### Large Lists
- Track lists: No virtualization. Long playlists or album track lists render all rows.
- Library artists/albums: Paginated (limit/offset); grid/list renders full page.

### Image Loading
- Cover art: Uses `CachedImage`; Service Worker caches `/api/library/cover-art/*`.
- No explicit lazy loading or responsive image sizes documented.

---

## 6. Startup & Docker

### Services in Container
- Single `lidify` service (Next.js + Express backend in one process).
- PostgreSQL, Redis – typically external or sidecar.
- Audio analyzers (Essentia, CLAP) – separate workers/containers if enabled.

### Startup Sequence
1. Workers start: enrichment, mood bucket, library list cache refresh.
2. Data integrity: 10s delay, then every 24h.
3. Reconciliation: 2 min delay, then every 2 min (Lidarr).
4. Lidarr cleanup: 30s initial, then every 5 min.

### Migrations
- Prisma migrations run on startup (or via separate step). No conditional skip.

---

## 7. Request Timeouts

| Endpoint | Timeout |
|----------|---------|
| `/api/library/albums`, `/api/library/artists` | 15s |
| `/api/mixes/audiomuse/instant` | 180s |
| Default (most routes) | 90s |
| Stream, health, docs | No timeout |

---

## 8. Existing Improvement Plans

### LOAD-TIME-IMPROVEMENT-PLAN.md (Artist & Album Pages)

**Phase 1 – Quick wins**:
1. Parallelize enrichment (MusicBrainz, Last.fm, Fanart, Deezer in parallel).
2. Skeleton loading instead of full LoadingScreen.
3. Album tracks limit / pagination for large albums.
4. Album prefetch on hover (like artist prefetch).

**Phase 2**:
5. Two-phase artist response (minimal first, enrichment second).
6. Cap artist albums (e.g. limit 50).
7. Extend enrichment cache TTL (1h → 6h or 24h).
8. Defer similar-artist images.

**Phase 3**:
9. Streaming / partial response.
10. Background enrichment on library list view.

---

## 9. Recommended Audit Implementation Order

### Step 1: Profile & Measure (1–2 days)
- Add timing logs to slow routes: `GET /library/artists`, `GET /library/albums`, `GET /library/artists/:id`, `GET /library/albums/:id`, `GET /playlists/:id`.
- Log: total duration, Jellyfin call count, DB query count.
- Identify top 3–5 slowest operations.

### Step 2: Worker Tuning (low effort)
- Add `LIDARR_ENABLED` or derive from settings: when false, skip reconciliation and Lidarr cleanup cycles.
- Consider skipping mood bucket worker when no local analyzed tracks (Jellyfin-only).
- Document which workers are safe to disable per deployment type.

### Step 3: Jellyfin Optimizations (medium effort)
- **Artist album counts**: Cache in Redis (key: `jf:artist:${id}:albumCount`, TTL 5–10 min) to avoid N calls per library load.
- **resolveTrackReferences**: Parallelize batches (e.g. 4 batches of 50 in parallel instead of sequential).
- **getJellyfinFavorites**: Audit for batch support; reduce per-item calls if possible.

### Step 4: Frontend Quick Wins (from LOAD-TIME-IMPROVEMENT-PLAN)
- Skeleton loading for artist and album pages.
- Album prefetch on hover.
- Parallelize enrichment in `jellyfinArtistEnrichment.ts`.

### Step 5: Document & Maintain
- Add `PERFORMANCE.md` with findings, metrics, and runbook.
- Consider adding optional `?timing=1` query param to return `X-Response-Time` or timing breakdown in dev.

---

## 10. Files to Review / Modify

| Area | Files |
|------|-------|
| Workers | `backend/src/workers/index.ts`, `queues.ts`, `discoverCron.ts`, `unifiedEnrichment.ts`, `moodBucketWorker.ts` |
| Library routes | `backend/src/routes/library.ts` |
| Jellyfin service | `backend/src/services/jellyfin.ts` |
| Playlists | `backend/src/routes/playlists.ts` |
| Library cache | `backend/src/services/libraryListCache.ts` |
| React Query | `frontend/hooks/useQueries.ts` |
| Artist/Album pages | `frontend/app/artist/[id]/page.tsx`, `frontend/app/album/[id]/page.tsx` |
| Enrichment | `backend/src/services/jellyfinArtistEnrichment.ts` (or equivalent) |
| Docker | `docker-compose.prod.yml`, `Dockerfile` |

---

## 11. References

- [LIDIFIN-PLAN-V2.md](./LIDIFIN-PLAN-V2.md) – Section 5 Performance Audit
- [LOAD-TIME-IMPROVEMENT-PLAN.md](./LOAD-TIME-IMPROVEMENT-PLAN.md) – Artist & album load time improvements
- [README.md](./README.md) – Backend stability, timeouts, event loop monitor
- [Jellyfin API](https://api.jellyfin.org/) – Official API reference
