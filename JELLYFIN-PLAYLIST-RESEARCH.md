# Jellyfin Playlist Integration – Deep Research & Options

This document summarizes research into Jellyfin's Playlist API and proposes solutions for the "Track Unavailable" issue in Lidifin's Your Playlists feature.

---

## 1. Jellyfin Playlist API Summary

### Endpoints Used by Lidifin

| Endpoint | Purpose | Used For |
|----------|---------|----------|
| `GET /Users/{userId}/Items?IncludeItemTypes=Playlist` | List all playlists | Syncing playlist list |
| `GET /Playlists/{playlistId}/Items?UserId={userId}` | Get items in a playlist | Syncing track IDs into DB |
| `GET /Users/{userId}/Items?Ids=id1,id2,...` | Batch-fetch items by ID | Resolving track metadata (resolveTrackReferences) |
| `GET /Users/{userId}/Items/{itemId}` | Single item fetch | Per-item fallback |
| `POST /Playlists/{playlistId}/Items?Ids=...&UserId=...` | Add items | Adding tracks |
| `DELETE /Playlists/{playlistId}/Items` (body: EntryIds) | Remove items | Removing tracks |

### GET /Playlists/{id}/Items Response Structure (Emby/Jellyfin)

Per [Emby API docs](https://dev.emby.media/reference/RestAPI/PlaylistService/getPlaylistsByIdItems.html):

- **Response**: `QueryResult_BaseItemDto` with `Items: BaseItemDto[]`
- Each item is a full **BaseItemDto** (the actual media item, e.g. Audio track)
- **Id** = The media item's server identifier (the **track ID** – used for playback)
- **PlaylistItemId** = The playlist entry identifier (used for remove/reorder via `EntryIds`)
- **Name**, **RunTimeTicks**, **AlbumId**, **AlbumArtists**, **ImageTags**, etc. are available when requested via `Fields`

**Important**: The playlist items response returns the **actual media items** (tracks), not just references. Each item's `Id` is the track ID. The response can include full metadata if `Fields` is specified.

### GET /Users/{userId}/Items?Ids=... (resolveTrackReferences)

- **Ids** = Comma-separated list of item IDs (e.g. `Ids=uuid1,uuid2,uuid3`)
- **IncludeItemTypes** = `"Audio"` filters results to audio items
- **Fields** = Controls which metadata is returned
- Returns `Items: BaseItemDto[]` for items that exist and match the filter

---

## 2. Current Lidifin Data Flow

### Sync (when listing playlists)

```
getJellyfinPlaylists() 
  → for each NEW playlist (not in DB):
      getJellyfinPlaylistItems(cfg, jp.id)
        → items.map(it => ({ entryId: it.PlaylistItemId ?? it.Id, itemId: it.Id }))
      → store trackId = "jellyfin:" + itemId in PlaylistItem
```

**Note**: Sync only runs for playlists **not already in DB**. Existing playlists are never re-synced from Jellyfin.

### Display (when opening a playlist)

```
GET /playlists/:id
  → trackIds = playlist.items.map(i => i.trackId)   // e.g. ["jellyfin:uuid1", ...]
  → resolved = resolveTrackReferences(trackIds)
    → GET /Users/{userId}/Items?Ids=uuid1,uuid2,...&IncludeItemTypes=Audio
    → map response Items to ResolvedTrack
  → formattedItems = map resolved[idx] to { track: ... }
  → if resolved[idx] is null → track: null → "Track unavailable"
```

---

## 3. Possible Root Causes

### A. Id vs PlaylistItemId Confusion

**Current mapping**: `itemId: it.Id` (we use `Id` as the track ID)

Per Emby/Jellyfin docs, `Id` is the media item ID and `PlaylistItemId` is the playlist entry ID. Our mapping appears correct. However, some Jellyfin versions or plugins might return a different structure (e.g. `Id` as entry id in some edge cases). **Worth verifying** with a real API response.

### B. resolveTrackReferences Failures

- **Ids parameter**: Jellyfin typically uses `Ids` (PascalCase). Some clients use `ids` (camelCase). Our code uses `Ids`.
- **IncludeItemTypes=Audio**: May filter out items if Jellyfin returns non-Audio types. Unlikely to affect valid track IDs.
- **Batch size**: We use 50. URL length limits could truncate long ID lists.
- **Per-item fallback**: Already implemented for nulls; uses `resolveTrackReference` (single-item fetch).

### C. Tracks Deleted from Jellyfin

If a track was removed from the library but the playlist still references it, `resolveTrackReferences` will return null. The playlist sync stored the ID at sync time; we never re-validate.

### D. No Re-Sync of Existing Playlists

When a user opens "Your Playlists", we only sync **new** Jellyfin playlists. We never:
- Re-fetch items for playlists already in DB
- Update our DB when items are added/removed in Jellyfin

So our stored `trackId`s can become stale.

### E. Playlist Items Response Lacks Fields

`getJellyfinPlaylistItems` does **not** request `Fields`. The default response may omit `AlbumArtists`, `ImageTags`, etc. We only use `Id` and `PlaylistItemId` from that response, so this doesn't affect our stored IDs. But it means we **must** use `resolveTrackReferences` for metadata – we're not using the playlist response for display.

---

## 4. Proposed Solutions

### Option A: Use Playlist Items Response Directly (Recommended)

**Idea**: `GET /Playlists/{id}/Items` returns full `BaseItemDto` for each track. Request `Fields` to get metadata, then map directly to `ResolvedTrack` – **no second API call**.

**Pros**:
- Single API call instead of two (playlist items + batch Items)
- No dependency on `resolveTrackReferences` for playlist display
- Uses the same endpoint that provided the IDs – consistency guaranteed
- Faster and more reliable

**Cons**:
- Requires a new code path for "get playlist with full track data"
- Playlist detail would need to call Jellyfin directly when `jellyfinPlaylistId` exists, instead of using DB + resolve

**Implementation**:
1. Add `getJellyfinPlaylistItemsWithMetadata(cfg, playlistId)` that calls `GET /Playlists/{id}/Items` with `Fields=Id,Name,RunTimeTicks,AlbumId,AlbumArtists,ImageTags,ParentId` (and `UserId`).
2. Map each item to `ResolvedTrack` using existing `mapJellyfinItemToTrack` logic.
3. For `GET /playlists/:id`: when `playlist.jellyfinPlaylistId` exists, call this instead of `resolveTrackReferences(trackIds)`.
4. Keep `resolveTrackReferences` for non-Jellyfin playlists and other features.

### Option B: Fix resolveTrackReferences Only

**Idea**: Improve the existing resolution path – fix params, add logging, ensure fallbacks work.

**Changes**:
- Try `ids` (lowercase) if `Ids` fails (some Jellyfin versions)
- Add detailed logging: request URL, response count, null count
- Remove `IncludeItemTypes=Audio` temporarily to test if it filters out valid items
- Ensure per-item fallback runs for all nulls

**Pros**: Minimal change, keeps current architecture.
**Cons**: Still two API calls; root cause may be elsewhere (e.g. wrong IDs stored).

### Option C: Hybrid – Prefer Playlist Items, Fallback to Resolve

**Idea**: For Jellyfin playlists, try Option A first. If that fails (e.g. playlist not in Jellyfin, or API error), fall back to Option B (DB + resolveTrackReferences).

**Pros**: Best of both; resilient.
**Cons**: More code paths to maintain.

### Option D: Periodic Re-Sync of Playlist Items

**Idea**: When displaying a playlist, if it has `jellyfinPlaylistId`, re-fetch items from Jellyfin and update the DB before resolving. Ensures we have current IDs.

**Pros**: Keeps DB in sync with Jellyfin.
**Cons**: Extra API call on every playlist view; more DB writes; doesn't fix resolution if the IDs are correct but resolution fails.

---

## 5. Bottlenecks & Considerations

| Bottleneck | Impact | Mitigation |
|------------|--------|-------------|
| Two-step resolution (playlist items → batch Items) | Extra latency, extra failure point | Option A eliminates this |
| Batch URL length | 50 IDs × 36 chars ≈ 1800 chars; may hit limits | Smaller batches or Option A |
| No re-sync of existing playlists | Stale track IDs in DB | Option D or background sync job |
| Tracks deleted from library | Unavoidable nulls | Show "Track unavailable" with option to remove from playlist |
| Jellyfin API version differences | Params/response may vary | Add logging; support both `Ids` and `ids` |

---

## 6. Recommendation

**Primary**: Implement **Option A** – use the playlist items response directly for Jellyfin playlists. It removes the resolution step, reduces API calls, and aligns with how Jellyfin structures playlist data.

**Secondary**: Add **Option D** (or a lighter variant) – when opening a Jellyfin playlist, optionally refresh items from Jellyfin so our DB stays in sync. This can be done in the background or on-demand.

---

## 7. Implementation Status (Completed)

- **Option A**: Implemented. `getJellyfinPlaylistItemsWithMetadata()` fetches from `GET /Playlists/{id}/Items` with Fields; used in `GET /playlists/:id` when `jellyfinPlaylistId` exists.
- **Option D**: Implemented. `syncJellyfinPlaylistToDb()` runs in background (fire-and-forget) after returning the response; upserts/removes PlaylistItem records to match Jellyfin.

**Debugging**: Before or alongside implementation, add logging to confirm:
1. What `getJellyfinPlaylistItems` actually returns (log first few items)
2. What `resolveTrackReferences` sends and receives (log batch request/response counts)
3. Whether any track IDs in the DB are invalid (e.g. from a different Jellyfin library)

---

## 8. Jellyfin API Reference Links

- [Emby PlaylistService getPlaylistsByIdItems](https://dev.emby.media/reference/RestAPI/PlaylistService/getPlaylistsByIdItems.html)
- [Jellyfin API – Playlists](https://api.jellyfin.org/#tag/Playlists)
- [BaseItemDto (Emby)](https://dev.emby.media/reference/pluginapi/MediaBrowser.Model.Dto.BaseItemDto.html)
- [PlaylistsApiGetPlaylistItemsRequest (Jellyfin SDK)](https://typescript-sdk.jellyfin.org/interfaces/generated-client.PlaylistsApiGetPlaylistItemsRequest.html)
