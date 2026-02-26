# Lidifin Plan V2 – Root Cause Analysis & Implementation Plan

This document addresses the **five remaining issues** reported after the initial fix round, with root cause analysis and concrete implementation steps.

---

## Status: lidify-fork References

**No `lidify-fork` references remain** in the repository. The conversion to `lidifin` is complete. The only "lidify" references are internal (e.g. `lidify-theme`, `lidify` as DB/service name) and do not need changing.

---

## 1. Radio Page – Instant Playlist (MoodMixer) Not Responding

### Problem
After clicking a mood in the Instant Playlist modal, nothing happens. No loading indicator, no error message, no playback.

### Root Cause Analysis

1. **MoodMixer.tsx** (lines 195–286):
   - Calls `api.getAudioMuseInstantPlaylist({ mood })` when `audioMuseAvailable` is true
   - Sets `setGenerating(mood)` but the UI may not show it clearly
   - On success: `playTracksFromResult(result.tracks, config)` and closes
   - On failure: catches error, toasts, but the catch block may swallow errors silently if `result.tracks` is empty
   - **AudioMuse status**: `loadAudioMuseStatus()` runs on open; if it fails, `audioMuseAvailable` is false and it falls back to mood bucket (which may have 0 tracks)

2. **Backend** (`/mixes/audiomuse/instant`):
   - Requires Jellyfin + AudioMuse-AI
   - Calls `generateInstantPlaylist(prompt)` in `audioMuseService.ts`
   - AudioMuse-AI endpoint: `POST ${config.url}/chat/api/chatPlaylist` with `userInput`, `ai_provider`
   - Possible failures: AudioMuse unreachable, wrong URL, AI provider not configured, timeout (60s)

3. **Likely causes**:
   - AudioMuse-AI returns empty or error; backend returns 400/500; frontend may not surface the error
   - No visible loading state while waiting (can take 30–60s)
   - `audioMuseAvailable` is true from status check, but the actual instant playlist call fails

### Solution

1. **Loading indicator**: Ensure `generating` state is visible (e.g. spinner on the clicked mood, disabled buttons)
2. **Error handling**: In `MoodMixer.generateMix`, surface backend errors via toast; log to console for debugging
3. **Backend**: Return structured error messages (e.g. `result.error`) so the frontend can display them
4. **Fallback**: If AudioMuse returns empty, fall through to mood bucket and show a message if that also fails

### Files to Modify

- `frontend/components/MoodMixer.tsx` – loading UI, error toasts, fallback messaging
- `backend/src/services/audioMuseService.ts` – ensure errors are propagated
- `backend/src/routes/mixes.ts` – return error details in JSON

---

## 2. Radio Page – Artist Similarity Modal

### Problem
User reported only a "Cancel" button; no way to submit the artist name.

### Current Implementation (Verified)

- **radio/page.tsx** (lines 576–607): Modal has:
  - Text input: `artistSearchQuery` with placeholder "e.g. Against Me!"
  - Cancel button
  - **"Start Radio"** button that calls `handleArtistSimilarityClick`
  - Enter key: `onKeyDown={(e) => e.key === "Enter" && handleArtistSimilarityClick()}`

So the submit path exists. Possible issues:

1. **Visibility**: "Start Radio" may be hidden or styled so it looks disabled (e.g. `disabled={artistSimilarityLoading}`)
2. **Empty input**: `handleArtistSimilarityClick` shows toast "Enter an artist name" if `query` is empty
3. **Layout/theme**: Button may be low contrast or off-screen on some viewports

### Solution

1. **UX**: Make the submit button more prominent (e.g. primary style, larger)
2. **Validation**: Disable "Start Radio" when `!artistSearchQuery.trim()` and show helper text
3. **Accessibility**: Ensure `aria-label` and focus management; verify modal is scrollable on small screens

### Files to Modify

- `frontend/app/radio/page.tsx` – improve Artist Similarity modal layout and button visibility

---

## 3. Favorites (Heart Icons) Unresponsive Outside Favorites Section

### Problem
Heart icons are visible on Album, Library, Search, Artist pages and MiniPlayer, but clicking does nothing: no visual change, no update in Jellyfin.

### Root Cause Analysis

1. **Frontend flow**:
   - `onToggleFavorite(trackId, !isFavorite)` → `if (isFavorite) addFavorite(trackId); else removeFavorite(trackId);`
   - `useFavorites.addFavorite` calls `api.addFavorite(trackId)` then `fetchFavorites()`
   - `favoriteIds` is derived from `tracks` (from `api.getFavorites()`)
   - No optimistic update on add; only `removeFavorite` does `setTracks(prev => prev.filter(...))`

2. **Backend**:
   - `POST /library/favorites/:trackId` → `addJellyfinFavorite(cfg, rawId)`
   - Jellyfin call: `client.post(\`/UserFavoriteItems/${itemId}\`)`
   - Jellyfin API: Official docs use `POST /Users/{UserId}/FavoriteItems/{Id}` – path may differ

3. **Possible causes**:
   - **Wrong Jellyfin path**: Backend uses `/UserFavoriteItems/${itemId}` but Jellyfin API expects `/Users/{userId}/FavoriteItems/{itemId}`. The current path may be invalid.
   - **API failures**: 401, 404, 500 – frontend may not show errors
   - **No optimistic update**: User waits for refetch; if refetch fails, no feedback
   - **Track ID format**: `jellyfin:uuid` must be correct; backend strips prefix

### Solution

1. **Jellyfin API**: Fix path to `/Users/{userId}/FavoriteItems/{itemId}` (POST / DELETE). Jellyfin requires the user-scoped path; `/UserFavoriteItems/` is incorrect.
2. **Error handling**: In `useFavorites.addFavorite`/`removeFavorite`, catch errors and show toast (e.g. "Could not update favorite")
3. **Optimistic update**: On add, optimistically add `trackId` to local state before refetch; revert on error
4. **Refetch**: Ensure `fetchFavorites` is called after add/remove; consider React Query for cache invalidation

### Files to Modify

- `backend/src/services/jellyfin.ts` – fix Jellyfin favorite API path if needed
- `frontend/hooks/useFavorites.ts` – optimistic updates, error toasts
- Verify all pages pass `favoriteIds` and `onToggleFavorite` correctly (already done)

---

## 4. Your Playlists – "Track Unavailable"

### Problem
Playlist detail page shows "Track Unavailable" for all tracks; no metadata, no playback.

### Root Cause Analysis

1. **Data flow**:
   - Playlists stored in Prisma; items have `trackId` (e.g. `jellyfin:uuid`)
   - `GET /playlists/:id` calls `resolveTrackReferences(trackIds)`
   - `formattedItems` maps `resolved[idx]` to `track`; if `resolved[idx]` is null → `track: null`
   - Frontend shows "Track unavailable" when `!playlistItem.track?.album?.artist`

2. **resolveTrackReferences** (`jellyfin.ts`):
   - Uses `GET /Users/{userId}/Items?Ids=id1,id2,...`
   - Jellyfin API: Parameter may be `Ids` (PascalCase) or `ids` (camelCase) – verify with OpenAPI
   - Batches of 100; if any batch fails, those slots stay null
   - Returns null for items not in response or when `item.Type !== "Audio"`

3. **Possible causes**:
   - **Wrong parameter**: Jellyfin might expect `ids` (array) not `Ids` (comma string)
   - **Tracks removed**: Items deleted from Jellyfin but still in playlist
   - **Sync issue**: Jellyfin playlist items use different IDs (e.g. `PlaylistItemId` vs `Id`)
   - **getJellyfinPlaylistItems**: Returns `itemId: it.Id` – confirm Jellyfin returns track Id in `Items[].Id`

### Solution

1. **Jellyfin Items API**: Check OpenAPI spec for correct parameter name and format for `/Users/{userId}/Items`
2. **Logging**: Log batch requests/responses and null counts in `resolveTrackReferences` for debugging
3. **getJellyfinPlaylistItems**: Verify Jellyfin response structure; ensure we use the track Id, not playlist entry Id
4. **Fallback**: If batch fails, retry with individual `getJellyfinItem` calls for remaining IDs

### Files to Modify

- `backend/src/services/jellyfin.ts` – verify Items API params, add logging, optional per-item fallback
- `backend/src/services/jellyfin.ts` – verify `getJellyfinPlaylistItems` mapping

---

## 5. Performance Audit

### Problem
App is slow, especially when loading library content. Need to identify unnecessary processes, workers, and inefficient operations.

### Areas to Audit

1. **Backend workers**:
   - List all workers (e.g. `cleanupDiscovery`, download queue, etc.)
   - Determine which are still needed for Jellyfin-only mode
   - Disable or reduce frequency of unused workers

2. **Database**:
   - Prisma queries: N+1 patterns, missing indexes
   - Library/artist/album queries: pagination, caching

3. **Jellyfin API**:
   - `resolveTrackReferences`: batch size, parallel requests
   - `getJellyfinFavorites`: fetches album per item – consider batch
   - Album/artist resolution: avoid redundant calls

4. **Frontend**:
   - React Query: stale times, cache invalidation
   - Large lists: virtualization for track lists
   - Image loading: lazy loading, appropriate sizes

5. **Startup**:
   - Docker/supervisor: which services start; any unnecessary ones
   - Database migrations: run only when needed

### Implementation Steps

1. **Audit workers**: List `backend/src/workers/*`, document purpose, disable if unused
2. **Profile**: Add timing logs for slow routes (library, playlists, favorites)
3. **Optimize**: Address top 3–5 bottlenecks first
4. **Document**: Add PERFORMANCE.md with findings and recommendations

### Files to Review

- `backend/src/workers/*`
- `backend/src/routes/library.ts` (artist, album, tracks)
- `backend/src/routes/playlists.ts`
- `backend/src/services/jellyfin.ts`
- `frontend/hooks/useQueries.ts` (stale times)
- `Dockerfile` / `supervisor` config

---

## Implementation Order

1. **Favorites** – High impact, user-facing; fix Jellyfin path + optimistic updates
2. **Instant Playlist** – Loading + error handling so users get feedback
3. **Artist Similarity** – UX polish for modal
4. **Playlists** – Debug + fix track resolution
5. **Performance** – Audit and incremental improvements

---

## References

- [Jellyfin API – MarkFavoriteItem](https://api.jellyfin.org/#tag/UserLibrary/operation/MarkFavoriteItem)
- [Jellyfin API – Playlists](https://api.jellyfin.org/#tag/Playlists)
- [AudioMuse-AI docs](https://github.com/NeptuneHub/AudioMuse-AI/tree/main/docs)
- [AudioMuse-AI Architecture](https://github.com/NeptuneHub/AudioMuse-AI/blob/main/docs/ARCHITECTURE.md)
