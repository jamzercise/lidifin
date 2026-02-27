# Item Enrichment & Last.fm Vibes for Radio

Research on enriching items when Jellyfin data is missing, and using Last.fm vibes/mood data for Radio stations.

---

## 0. Storage Architecture (Effectiveness, Efficiency, Performance)

Before implementing, here’s how enrichment/vibe data is stored and how to keep it effective, efficient, and fast.

### Current Storage Model

| Location | Field | Type | Indexed? | Used For |
|----------|-------|------|----------|----------|
| **Track** | `lastfmTags` | `TEXT[]` | ❌ No | Mood radio, vibe match, programmatic playlists |
| **Track** | `moodTags` | `TEXT[]` | ❌ No | Legacy MusiCNN; vibe match fallback |
| **Track** | `essentiaGenres` | `TEXT[]` | ❌ No | Genre/vibe matching |
| **Artist** | `genres` | `Json` | ❌ No | Genre radio, discovery |
| **Album** | `genres` | `Json` | ❌ No | Genre fallback |

**Jellyfin tracks** are not in the Track table. They’re resolved from the Jellyfin API. Any enrichment for Jellyfin tracks must live elsewhere (Redis or a separate metadata table).

### Query Patterns

- **Mood radio**: `lastfmTags: { has: 'chill' }` → PostgreSQL `lastfmTags @> ARRAY['chill']`
- **Vibe match**: Load ~15k tracks with `lastfmTags`, `moodTags`, `essentiaGenres` into memory for similarity scoring
- **Programmatic playlists**: `lastfmTags: { hasSome: ['chill', 'relax'] }` → `&&` (overlap)

### Performance Considerations

1. **No GIN index on array columns** – `lastfmTags`, `moodTags`, `essentiaGenres` have no index. Queries like `lastfmTags @> ARRAY['chill']` fall back to sequential scans. For 10k–100k tracks this can add noticeable latency (tens to hundreds of ms).

2. **GIN index on arrays** – PostgreSQL supports `CREATE INDEX ... USING GIN (array_column)` for `@>` (contains) and `&&` (overlap). Adding a GIN index on `lastfmTags` would make mood/vibe queries index-backed.

3. **Selective loading** – Most list endpoints (album tracks, search) do not select `lastfmTags`. Only Radio and vibe-match load them. Keeping `lastfmTags` out of default selects avoids extra I/O.

4. **Vibe match cap** – The vibe radio already caps at 15k analyzed tracks to avoid loading too much. That’s a good safeguard.

### Storage Efficiency

- **Per track**: ~3–10 tags × ~15–30 chars ≈ 50–300 bytes for `lastfmTags`
- **100k tracks**: ~5–30 MB for `lastfmTags` – small relative to DB size
- **Sentinel values**: `_no_mood_tags`, `_not_found` are single-element arrays; cheap and easy to filter

### Recommended Storage Strategy

| Aspect | Recommendation |
|--------|----------------|
| **Index** | Add GIN index on `Track.lastfmTags` for `@>` and `&&` queries |
| **Where to store** | Keep `lastfmTags` on Track (Prisma). No need for a separate table for native library |
| **Jellyfin tracks** | Store enrichment in Redis: `jellyfin:track:vibes:{itemId}` with TTL (e.g. 24h). Or a `JellyfinTrackMetadata` table if you want persistence |
| **Album/artist fallback** | Option A: Denormalize – add `Album.lastfmTags` (Json or String[]) for fallback. Option B: Compute on read – when track has no tags, fetch artist/album tags from Last.fm and cache in Redis |
| **Aggregate vibes** | For “top vibes in library” – compute on demand and cache in Redis (`library:vibes:counts`, TTL 1h) rather than storing a separate table |

### Implementation Order for Storage

1. **Add GIN index** on `Track.lastfmTags` – low risk, improves mood/vibe query performance. Prisma supports it: `@@index([lastfmTags], type: Gin)` in the Track model.
2. **Keep current schema** – no schema change needed for Phase 1 (Vibes UI + track tag fallback)
3. **Jellyfin metadata** – decide Redis vs table when adding Jellyfin radio support
4. **Album tags** – add `Album.lastfmTags` only if you implement album-level fallback and want to persist it

### Loading Impact

- **Page load**: Normal browsing (artists, albums, track lists) does not load `lastfmTags`. No impact.
- **Radio start**: One query filtered by `lastfmTags` (or other criteria). With a GIN index, sub-50ms for typical libraries.
- **Enrichment**: Background worker writes; no user-facing latency.
- **Redis for Jellyfin**: Reads are fast; writes are async. Minimal impact.

---

## 1. Current Item Enrichment (Missing Data)

### What Exists Today

| Item Type | Source | Enrichment | When |
|-----------|--------|------------|------|
| **Artist** | Jellyfin | `enrichJellyfinArtist()` – bio, hero image, top tracks, similar artists, all albums | On-demand when library returns Jellyfin artist |
| **Artist** | Prisma (Lidarr) | Full enrichment via unified worker – bio, genres, top tracks, similar artists | Background worker |
| **Track** | All | `lastfmTags` from `track.getInfo` → `toptags.tag` | Background worker (unified enrichment) |
| **Album** | Last.fm | `album.getInfo` – tags, wiki | Discovery only; not stored per-track |

### Gaps (When Data Is Missing)

1. **Jellyfin albums** – No on-the-fly enrichment when album metadata (bio, tags, cover) is sparse.
2. **Jellyfin tracks** – No fallback when `track.getInfo` returns no `toptags`; we store `_not_found` or `_no_mood_tags`.
3. **Artist tags fallback** – When a track has no Last.fm tags, we could inherit artist tags (from `artist.getInfo` → `tags.tag`).
4. **Album tags fallback** – When track tags fail, we could use `album.getInfo` → `tags.tag` for that track’s album.

---

## 2. Last.fm Vibes & Mood Data

### What Last.fm Exposes

| API Method | Returns | Use Today |
|------------|---------|-----------|
| `track.getInfo` | `toptags.tag[]` – user-applied track tags | ✅ Stored in `Track.lastfmTags` (filtered to MOOD_TAGS) |
| `artist.getInfo` | `tags.tag[]` – artist tags | ✅ Used for discovery, Artist.genres; not stored for Radio |
| `album.getInfo` | `tags.tag[]` – album tags | Used in discovery; not stored per-track |
| `tag.getTopTracks` | Top tracks for a tag (e.g. "chill", "workout") | ❌ Not used |
| `tag.getTopAlbums` | Top albums for a tag | ✅ Used in `lastFmService.getTopAlbumsByTag()` |

### Current Mood Tag Filter

`unifiedEnrichment.ts` filters Last.fm tags to a fixed `MOOD_TAGS` set (~50 tags), including:

- **Energy**: chill, relax, energetic, upbeat, party, dance, workout, gym, running…
- **Emotions**: sad, melancholy, happy, feel good, romantic, love, angry, intense…
- **Setting**: night, evening, morning, summer, winter, rainy, driving, road trip…
- **Activity**: study, focus, work, sleep, bedtime…
- **Vibe**: dreamy, atmospheric, groovy, funky, smooth, dark, epic, nostalgic…

Tracks without matching mood tags get `_no_mood_tags`; tracks not found on Last.fm get `_not_found`.

---

## 3. Radio Section – Current vs Potential

### Current Radio Types

| Type | Filter | Data Source |
|------|--------|-------------|
| **genre** | Artist.genres, Artist.userGenres | Last.fm artist tags (via enrichment) |
| **decade** | Album.releaseYear | Jellyfin/MusicBrainz |
| **discovery** | Least-played tracks | Play counts |
| **favorites** | Most-played tracks | Play counts |
| **workout** | energy ≥ 0.65, bpm ≥ 115, or moodTags/workout genres | Audio analysis + lastfmTags + genres |
| **artist** | Artist + similar artists (Last.fm) | SimilarArtist table, genre fallback |
| **mood** | Backend supports it | Audio analysis (energy, valence, etc.) **or** lastfmTags |

### Mood Radio (Backend Only)

The backend `/library/radio?type=mood&value=X` supports:

- **Hardcoded moods**: high-energy, chill, happy, melancholy, dance, acoustic, instrumental
- **Fallback**: `lastfmTags: { has: moodValue }` for any other value (e.g. "road trip", "study")

The Radio UI does **not** expose mood stations yet – only genre, decade, discovery, favorites, workout, and “Shuffle All”.

### Potential: Vibe-Based Radio Stations

Using `lastfmTags` and Last.fm tag APIs, we can add:

1. **Vibe stations from library** – Filter by `lastfmTags` for tags like:
   - chill, relax, calm
   - workout, energetic, party
   - sad, melancholy
   - driving, road trip
   - study, focus
   - night, late night
   - romantic, love

2. **Dynamic vibe stations** – Use `tag.getTopTracks` to get Last.fm’s top tracks for a tag, then **match to library** (by artist+title or mbid). Only play tracks the user owns.

3. **Hybrid** – Combine:
   - Audio analysis (energy, valence, bpm) for analyzed tracks
   - lastfmTags for unanalyzed tracks
   - Artist/album tags as fallback when track tags are missing

---

## 4. Proposed Enhancements

### A. Item Enrichment (Missing Data)

| Enhancement | Effort | Impact |
|-------------|--------|--------|
| **Album enrichment** – On-the-fly Last.fm/MusicBrainz when Jellyfin album has no bio/cover | Medium | Better album pages |
| **Track tag fallback** – If `track.getInfo` has no toptags, use artist tags or album tags | Low | More tracks get lastfmTags |
| **Expand MOOD_TAGS** – Add more Last.fm tags (e.g. "lofi", "vibes", "chillhop") | Low | Richer vibe coverage |

### B. Vibes for Radio

| Enhancement | Effort | Impact |
|-------------|--------|--------|
| **Expose mood radio in UI** – Add “Vibes” section with preset moods (Chill, Energetic, Sad, etc.) | Low | Users can pick mood stations |
| **Vibe stations from lastfmTags** – New station type `vibe` that filters by tag | Low | More variety |
| **Dynamic vibe stations** – `tag.getTopTracks` → match to library | Medium | Discovery of new vibes |
| **Aggregate library vibes** – API to return top lastfmTags in library for UI | Low | Show “Your Chill Tracks”, etc. |

### C. Data Model (Optional)

- **Album.lastfmTags** – Store album tags for fallback and album-level vibe filtering.
- **Artist.lastfmTags** – Store artist tags for fallback (or keep using Artist.genres).
- **Track tag fallback chain** – track tags → artist tags → album tags.

---

## 5. Implementation Order

**Phase 1 – Quick wins**

1. Add **Vibes** section to Radio page with preset mood stations (chill, energetic, sad, romantic, study, driving).
2. Add **track tag fallback** – when `track.getInfo` has no toptags, try artist tags from `artist.getInfo`.

**Phase 2 – Enrichment**

3. **Album enrichment** – On-the-fly when Jellyfin album metadata is sparse.
4. **Expand MOOD_TAGS** – Add lofi, chillhop, vibes, etc.

**Phase 3 – Advanced**

5. **Dynamic vibe stations** – `tag.getTopTracks` + library matching.
6. **Aggregate vibes API** – `/library/vibes` returning top tags and counts for Radio UI.

---

## 6. Last.fm API Methods to Add

```typescript
// In lastfm.ts - for vibe-based radio
async getTopTracksByTag(tag: string, limit = 50) {
  const data = await this.request({
    method: "tag.getTopTracks",
    tag,
    api_key: this.apiKey,
    format: "json",
    limit,
  });
  return data.tracks?.track || [];
}
```

`tag.getTopTracks` returns `{ name, artist: { name }, mbid }` – we can match to library by artist+title or mbid.

---

## 7. Dependencies

- **Last.fm API key** – Already configured
- **Rate limits** – MusicBrainz 1 req/sec; Last.fm ~5 req/sec (check docs)
- **Redis** – Cache tag.getTopTracks results (e.g. 6–24 hours)

---

*Document created Feb 2025. Reflects current codebase state.*
