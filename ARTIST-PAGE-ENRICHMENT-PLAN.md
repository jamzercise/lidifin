# Artist Page Enrichment Plan

## Problem

When viewing an artist page via `/artist/{artist_name}` (Jellyfin artists), the page lacks metadata:

- **Bio** – artist biography/summary
- **Bio image** – hero/cover image (Jellyfin may provide cover art, but not always high-quality)
- **Popular songs** – top tracks from Last.fm
- **Popularity / monthly listeners** – from Last.fm
- **All albums** – both owned (in Jellyfin) and not owned (from MusicBrainz discovery)

## Current Data Flow

### Library API (`GET /library/artists/:id`)

- **Prisma artists**: Full enrichment (bio, heroUrl, genres, topTracks, similarArtists) from background workers
- **Jellyfin artists**: Minimal response – `bio: null`, `genres: []`, no topTracks from Last.fm, no similarArtists

### Discovery API (`GET /artists/discover/:nameOrMbid`)

- Fetches from MusicBrainz, Last.fm, Fanart.tv, Deezer
- Returns: bio, image, topTracks, albums (all from MusicBrainz – not owned), similarArtists, listeners, playcount

## Proposed Solution

### Option A: Enrich Jellyfin Artist Responses On-the-Fly (Recommended)

When the library returns a Jellyfin artist, augment the response with discovery-style metadata:

1. **If Jellyfin provides mbid** (from `ProviderIds.MusicbrainzArtist`):
   - Use mbid to fetch Last.fm (bio, top tracks, similar artists, listeners)
   - Use mbid to fetch MusicBrainz release groups (all albums, owned + not owned)
   - Use mbid for Fanart.tv / Deezer images if Jellyfin cover is low quality

2. **If no mbid**:
   - Search MusicBrainz by artist name to get mbid
   - Then proceed as above

3. **Merge strategy**:
   - **Albums**: Jellyfin albums (owned) + MusicBrainz release groups (filter to studio/EP, mark `owned: false` for those not in Jellyfin)
   - **Top tracks**: From Last.fm (or derive from Jellyfin play counts if available)
   - **Bio**: From Last.fm (filter disambiguation text)
   - **Image**: Prefer Jellyfin cover, fallback to Fanart/Deezer/Last.fm
   - **Similar artists**: From Last.fm

**Implementation location**: `backend/src/routes/library.ts` in the Jellyfin artist branch (around line 876–927).

**Caching**: Cache enriched Jellyfin artist responses in Redis (e.g. 1 hour TTL) to avoid repeated MusicBrainz/Last.fm calls.

### Option B: Frontend Merge

When the artist page receives a library response with `bio: null` and `source === "library"`, call the discovery API in parallel and merge:

- Pro: No backend changes
- Con: Two API calls per page load, more complex frontend logic, possible flicker

### Option C: Background Enrichment for Jellyfin

Create a worker that periodically enriches Jellyfin artists and stores results in a cache/table:

- Pro: Fast page loads, no on-demand external API calls
- Con: Requires new storage/cache layer for Jellyfin artist metadata, more infrastructure

## Recommended Implementation (Option A)

### Steps

1. **Create `enrichJellyfinArtist()` helper** in `backend/src/services/` (or inline in library route):
   - Input: artist name, optional mbid from Jellyfin
   - Output: `{ bio, image, topTracks, similarArtists, allAlbums }`
   - Uses: `musicBrainzService`, `lastFmService`, `fanartService`, `deezerService`

2. **Update library route** (`GET /library/artists/:id`):
   - When returning a Jellyfin artist, call `enrichJellyfinArtist()` before sending the response
   - Merge: owned albums from Jellyfin + discovery albums from MusicBrainz (dedupe by rgMbid)
   - Add `topTracks`, `similarArtists`, `bio`, improved `image` to the response

3. **Add Redis caching**:
   - Key: `jellyfin:artist:enriched:{artistNameOrMbid}`
   - TTL: 3600 (1 hour)
   - Reduces load on MusicBrainz/Last.fm

4. **Respect rate limits**:
   - MusicBrainz: 1 req/sec
   - Last.fm: check API limits
   - Consider a small in-memory queue if many users hit artist pages at once

### Data Sources Summary

| Field            | Source                    | Fallback              |
|------------------|---------------------------|------------------------|
| Bio              | Last.fm                   | -                      |
| Hero image       | Jellyfin → Fanart → Deezer → Last.fm | -        |
| Top tracks       | Last.fm                   | Jellyfin top 10        |
| Listeners/playcount | Last.fm                | -                      |
| All albums       | Jellyfin (owned) + MusicBrainz (not owned) | - |
| Similar artists  | Last.fm                   | -                      |

## Dependencies

- Last.fm API key (already used for discovery)
- MusicBrainz (no key required)
- Fanart.tv API key (if configured)
- Deezer (no key for basic lookups)

## Testing

1. Visit `/artist/Lucero` (or any Jellyfin artist)
2. Verify: bio, hero image, popular tracks, owned + available albums, similar artists
3. Verify: no regression for Prisma artists (Lidarr/native library)
4. Verify: discovery-only artists still work via `/artists/discover/`
