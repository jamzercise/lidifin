# Load Time Improvement Plan: Artists & Albums

## Current State Analysis

### Artist Page (Jellyfin flow)

**Request:** `GET /library/artists/:id` → single API call from frontend

**Backend sequence (blocking until complete):**

1. **Prisma lookup** – Fast (usually misses for Jellyfin artists)
2. **Jellyfin config** – Fast
3. **Jellyfin artist resolution** – 1–2 Jellyfin API calls (`getJellyfinItem` or `getJellyfinArtistByName`)
4. **Parallel:** `getJellyfinAlbumsAllForArtist` + `getJellyfinTracks`
   - Albums: paginates (200/page) – can be **multiple Jellyfin calls** for artists with many albums
   - Tracks: single call (limit 10)
5. **`enrichJellyfinArtist`** – main bottleneck:
   - Redis cache check (fast if hit)
   - **Sequential:** MusicBrainz search/getArtist → Last.fm getArtistInfo → top tracks → Fanart → Deezer
   - **Similar artists:** 10 × (Fanart + Deezer) in parallel
   - **Discovery albums:** MusicBrainz getReleaseGroups → first 10 albums × (Cover Art Archive HEAD + Deezer getAlbumCover)

**Total external API calls on cache miss:** ~15–30+ (Last.fm, MusicBrainz, Fanart, Deezer, Jellyfin, Cover Art Archive)

---

### Artist Page (Prisma flow)

- Single DB query with includes (albums, tracks, ownedAlbums)
- DataCacheService for images (DB + Redis)
- Generally faster than Jellyfin unless DB is slow

---

### Album Page (Jellyfin flow)

**Request:** `GET /library/albums/:id`

1. **Jellyfin:** `getJellyfinItem` + `getJellyfinTracksAllForAlbum`
   - Tracks: paginates (500/page) – can be **multiple calls** for large albums
2. **Album by rgMbid:** `getJellyfinAlbumByRgMbid` – may paginate through albums (up to 2000) to find match

---

### Album Page (Discovery flow)

- Uses `GET /artists/album/:mbid` – fetches from MusicBrainz, Last.fm, Fanart, Deezer, Cover Art Archive

---

## Proposed Improvements

### Phase 1: Quick wins (low effort)

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 1 | **Parallelize enrichment** – Run `getArtistInfo`, `getArtistTopTracks`, `getArtistImage` (Fanart + Deezer) in parallel instead of sequential | Artist page: ~1–2s faster | Low |
| 2 | **Skeleton loading** – Replace full `LoadingScreen` with skeleton UI (artist name, placeholder image, track rows) so page feels responsive faster | Perceived: much faster | Low |
| 3 | **Album tracks limit** – For album page, don’t fetch all tracks if > 100; use pagination or “load more” | Album page: faster for large albums | Low |
| 4 | **Album prefetch** – Add `usePrefetchAlbum` and `onMouseEnter` on album links (like artists) | Album page: often instant on click | Low |

### Phase 2: Medium effort

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 5 | **Two-phase artist response** – Return minimal payload first (name, coverArt, albums, topTracks from Jellyfin), then enrichment (bio, similar artists, discovery albums) in a second request or background | Artist page: above-the-fold visible in ~500ms | Medium |
| 6 | **Cap artist albums** – Don’t fetch all albums for artists with 50+; use `limit: 50` or similar | Artist page: fewer Jellyfin calls | Low |
| 7 | **Extend enrichment cache** – Increase Redis TTL from 1h to 6h or 24h for stable artist data | Repeat visits: faster | Low |
| 8 | **Defer similar-artist images** – Return similar artists without images initially; load images lazily on frontend | Enrichment: faster | Medium |

### Phase 3: Larger changes

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 9 | **Streaming / partial response** – Use HTTP streaming or chunked transfer to send core data first, then enrichment | Artist page: progressive loading | High |
| 10 | **Background enrichment** – When artist appears in library list or search, prefetch enrichment in background | Artist page: often cached on first visit | Medium |


---

## Recommended Implementation Order

1. **Phase 1.1** – Parallelize enrichment in `jellyfinArtistEnrichment.ts`
2. **Phase 1.2** – Skeleton loading for artist and album pages
3. **Phase 1.3** – Album prefetch on hover
4. **Phase 2.1** – Cap artist albums (e.g. limit 50)
5. **Phase 2.2** – Extend enrichment cache TTL
6. **Phase 2.3** – Two-phase artist response (optional, if still needed)

---

## Technical Notes

### Enrichment parallelization

Current flow:
```
getArtistInfo → (wait) → getTopTracks → (wait) → Fanart → Deezer → similar artists → release groups → album covers
```

Proposed:
```
Promise.all([
  getArtistInfo,
  getTopTracks,
  Promise.race([Fanart, Deezer])  // first wins
]) → similar artists (parallel) → release groups → album covers (parallel)
```

### Skeleton loading

- Artist: skeleton hero with name, placeholder circle, track rows (5–10)
- Album: skeleton hero with album art placeholder, track rows (10–15)
- Use `placeholderData` or `isPlaceholderData` in React Query to show skeleton while fetching

### Album prefetch

- Mirror `usePrefetchArtist` with `usePrefetchAlbum`
- Add to album links in: Discography, SimilarAlbums, Library albums grid, search results
