# Lidifin Fix Plan – To-Do List

This document outlines the plan to address the six issues identified for Lidifin.

---

## 1. Artist Search Result URL (MusicBrainz ID vs Artist Name)

### Problem
When searching for an Artist through the Search bar, the result links to a MusicBrainz ID-based URL (e.g. `/artist/a66ebddc-ff04-46b8-820a-15c63e80dba1`) instead of an artist name-based URL (e.g. `/artist/Against%20Me!`). The MusicBrainz ID version does not work in Jellyfin-only mode and does not show Jellyfin artist data.

### Root Cause
- **TopResult.tsx** (line 26): For discovery artists, `artistId = discoveryArtist?.mbid || encodeURIComponent(name)` — MBID is preferred over name.
- **SimilarArtistsGrid.tsx** (line 36): Uses `result.mbid || encodeURIComponent(result.name)` — same behavior.
- The backend `/library/artists/:id` can resolve by name or MBID, but Jellyfin artists are typically looked up by name. When the URL is an MBID, the backend may not find a matching Jellyfin artist.

### Solution
1. **TopResult.tsx**: For discovery artists, always use `encodeURIComponent(name)` as the primary route ID. Only fall back to MBID when name is empty.
2. **SimilarArtistsGrid.tsx**: Same change — prefer `encodeURIComponent(result.name)` over `result.mbid`.
3. **useArtistData.ts**: The existing canonicalization (replace MBID URL with name URL after load) is good; ensure it runs for all artist sources.
4. **Backend**: Confirm `/library/artists/:id` resolves MBID to Jellyfin artist when possible (e.g. via Jellyfin ProviderIds). If not, the frontend change alone should fix most cases.

### Files to Modify
- `frontend/features/search/components/TopResult.tsx`
- `frontend/features/search/components/SimilarArtistsGrid.tsx`
- Optionally: `backend/src/routes/library.ts` (improve MBID → Jellyfin resolution if needed)

---

## 2. Playlist Details and Playback

### Problem
When clicking a Playlist under "Your Playlists", the page loads the title and length but:
- Does not show all tracks
- Play button does not work

### Root Cause
1. **Backend**: `resolveTrackReferences` in `jellyfin.ts` fetches Jellyfin items in a single request. For large playlists (e.g. 100+ tracks), Jellyfin may limit the `Ids` query parameter length or return partial results.
2. **Track resolution**: Some tracks may resolve to `null` (deleted from Jellyfin, sync issues, or batch limits), causing `track: null` in `formattedItems`.
3. **Frontend**: Uses `playlist.items` and `playableTracks` (filtered to `item.track?.album?.artist`). If many items have `track: null`, the list appears empty and playback has nothing to play.
4. **API response**: Backend returns `items: formattedItems`; `mergedItems` combines items + pending. Frontend uses `mergedItems || items` for display.

### Solution
1. **Backend – Batch resolution**: Update `resolveTrackReferences` to batch Jellyfin IDs (e.g. 50–100 per request) to avoid URL/request limits and ensure all tracks are resolved.
2. **Backend – Logging**: Add logging when tracks fail to resolve to help debug sync/deletion issues.
3. **Frontend – Null handling**: Ensure track rows with `track: null` render a placeholder (e.g. "Track unavailable") instead of crashing. The previous fix added optional chaining; verify all paths are covered.
4. **Frontend – Play button**: `handlePlayPlaylist` uses `playableTracks`; if `playableTracks` is empty due to all `track: null`, show a message like "No playable tracks" and disable the Play button.
5. **Cover art**: `coverUrls` is derived from `playlist.items` with `item.track.album?.coverArt`. If all tracks are null, the mosaic will be empty — consider a fallback placeholder image.

### Files to Modify
- `backend/src/services/jellyfin.ts` (batch `resolveTrackReferences`)
- `backend/src/routes/playlists.ts` (ensure response shape is correct)
- `frontend/app/playlist/[id]/page.tsx` (null handling, empty state, Play button disable)

---

## 3. Now Playing Favorites (Heart Icon)

### Problem
The Now Playing window does not show the heart icon to add a track to Jellyfin favorites.

### Root Cause
- **OverlayPlayer.tsx**: The heart icon is implemented and shown when `playbackType === "track" && currentTrack?.id?.startsWith("jellyfin:")`.
- **MiniPlayer.tsx**: Does not include the heart icon. Users who primarily use the bottom MiniPlayer (or never open the full overlay) will not see it.

### Solution
Add the heart icon and favorite toggle to **MiniPlayer.tsx**, mirroring the OverlayPlayer implementation:
- Import `Heart` and `useFavorites`
- Add a heart button next to the queue/expand controls when `playbackType === "track"` and `currentTrack?.id?.startsWith("jellyfin:")`
- Use `addFavorite` / `removeFavorite` and `favoriteIds.has(currentTrack.id)` for state

### Files to Modify
- `frontend/components/player/MiniPlayer.tsx`

---

## 4. Album Page Favorites Interaction

### Problem
The heart icon on the Album page is visible but unresponsive: it does not change state or add the track to favorites.

### Root Cause
- **TrackList.tsx**: Passes `onToggleFavorite(track.id, !isFavorite)` — the second argument is the *new* desired state (true = add, false = remove).
- **Album page** (line 207–210): Handler is `if (isFavorite) addFavorite(trackId); else removeFavorite(trackId);` — correct.
- **Library/Search/Artist pages**: Use `if (isFavorite) removeFavorite(trackId); else addFavorite(trackId);` — inverted logic.

The Album page logic is correct. Possible causes for unresponsiveness:
1. **API**: `addFavorite`/`removeFavorite` may be failing (e.g. 503, CORS, or Jellyfin unreachable).
2. **Track ID format**: Backend expects `jellyfin:uuid`; ensure album tracks use that format.
3. **State update**: `useFavorites` refetches after `addFavorite`; `favoriteIds` may not update if the refetch fails or is slow.
4. **Inverted logic elsewhere**: Library, Search, and Artist pages have inverted logic and should be fixed for consistency.

### Solution
1. **Fix inverted logic**: Update Library, Search, and Artist pages to use `if (isFavorite) addFavorite(trackId); else removeFavorite(trackId);` (same as Album page).
2. **Debugging**: Add error handling/toast in `useFavorites.addFavorite` when the API fails, so users see feedback.
3. **Optimistic update**: Consider optimistically updating `favoriteIds` in `addFavorite` before refetch to improve perceived responsiveness.
4. **Verification**: Confirm album tracks from Jellyfin have IDs like `jellyfin:uuid` and that the backend favorites routes work.

### Files to Modify
- `frontend/app/library/page.tsx`
- `frontend/app/search/page.tsx`
- `frontend/app/artist/[id]/page.tsx`
- `frontend/hooks/useFavorites.ts` (optional: error toasts, optimistic update)

---

## 5. Loading Indicators for Album and Artist Pages

### Problem
Album and Artist pages can take several seconds to load; users need clear feedback that data is loading.

### Current State
- **Artist page**: Uses `app/artist/[id]/loading.tsx` which renders `LoadingScreen` (spinner + "Loading...").
- **Album page**: Uses `AlbumPageSkeleton` when `loading` is true from `useAlbumData`.
- **LoadingScreen**: Full-screen spinner with optional message.

### Solution
1. **Artist page**: `loading.tsx` already provides a loading state. Ensure `useArtistData` sets `loading`/`isLoading` correctly and that the loading UI is shown during the initial fetch.
2. **Album page**: Already uses `AlbumPageSkeleton` when `loading` is true. Verify `useAlbumData` exposes loading state correctly.
3. **Optional enhancement**: Add a thin top progress bar (e.g. NProgress-style) for route transitions, or ensure the skeleton/spinner is visible immediately on navigation.

### Files to Verify/Modify
- `frontend/app/artist/[id]/loading.tsx` (already exists)
- `frontend/app/artist/[id]/page.tsx` (ensure loading state is used)
- `frontend/app/album/[id]/page.tsx` (already uses skeleton)
- `frontend/features/artist/hooks/useArtistData.ts`
- `frontend/features/album/hooks/useAlbumData.ts`

---

## 6. Enhanced AudioMuse-AI Integration (Radio Section)

### Problem
Integrate Instant Playlist, Similar Song, and Artist Similarity from AudioMuse-AI into the Radio section and other relevant pages.

### Current State
- **Radio page** (`app/radio/page.tsx`): Uses static stations (Shuffle All, Workout, Discovery, Favorites) and dynamic genre/decade stations. Fetches from `/library/radio` — no AudioMuse integration.
- **AudioMuse features**:
  - Instant Playlist: `MoodMixer` (chat-style), `POST /chat/api/chatPlaylist`
  - Similar Song: `FindSimilarModal` on album track rows, `GET /api/similar_tracks`
  - Artist Similarity: `SongsFromSimilarArtists` on artist page, `GET /api/similar_artists`, `GET /api/artist_tracks`
- **Mixes**: `useMixesQuery` / `api.getMixes()` — may include AudioMuse mixes.

### Solution
1. **Radio page – New AudioMuse section**:
   - Add an "AI-Powered" or "AudioMuse" section with:
     - **Instant Playlist**: Link/button to open MoodMixer or a simplified prompt input that generates a playlist from natural language.
     - **Similar Song Radio**: "Start from a song" — opens a modal to pick a track (or use current track) and generates similar-tracks radio.
     - **Artist Similarity Radio**: "Start from an artist" — pick artist, get similar artists’ tracks, play as radio.
   - Reuse existing `FindSimilarModal`, `MoodMixer`, and `SongsFromSimilarArtists` logic where possible.

2. **Surface on other pages**:
   - **Album page**: Find Similar (Sparkles) is already on track rows for Jellyfin tracks.
   - **Artist page**: SongsFromSimilarArtists is already present for Jellyfin artists.
   - **Now Playing / Queue**: Add "Find similar" or "Start Similar Radio" from current track.

3. **Backend**: Ensure `/mixes/*` routes for similar tracks, similar artists, and instant playlist are working and return playable tracks.

### Files to Modify
- `frontend/app/radio/page.tsx` (new AudioMuse section, links/modals)
- `frontend/components/MoodMixer.tsx` (ensure it can be opened from Radio)
- `frontend/components/AudioMuse/FindSimilarModal.tsx` (reuse for Similar Song Radio)
- `frontend/components/player/OverlayPlayer.tsx` or `MiniPlayer.tsx` (optional: "Find similar" from current track)
- `backend/src/routes/mixes.ts` (verify endpoints)

---

## Implementation Order

| # | Task                         | Priority | Complexity |
|---|------------------------------|----------|------------|
| 1 | Artist Search URL            | High     | Low        |
| 3 | Now Playing Favorites        | High     | Low        |
| 4 | Album Page Favorites         | High     | Low        |
| 5 | Loading Indicators           | Medium   | Low        |
| 2 | Playlist Details/Playback    | High     | Medium     |
| 6 | AudioMuse Radio Integration  | Medium   | Medium     |

Recommended order: 1 → 3 → 4 → 5 → 2 → 6.
