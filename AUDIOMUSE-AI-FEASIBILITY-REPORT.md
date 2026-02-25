# AudioMuse-AI Option 1 Feasibility Report

**Option 1**: Build all UI in Lidifin, use AudioMuse-AI purely as a backend API. All four features (Instant Playlist, Similar Song, Artist Similarity, Song Alchemy) with Lidifin-styled UI.

**Conclusion**: **Feasible.** AudioMuse-AI exposes HTTP APIs for all four features. Lidifin can call them and render results in its own UI.

---

## API Audit Summary

| Feature | AudioMuse-AI Endpoint | Method | Status |
|---------|----------------------|--------|--------|
| **Instant Playlist** | `/chat/api/chatPlaylist` | POST | ✅ Exists (already integrated) |
| **Similar Song** | `/api/similar_tracks` | GET | ✅ Exists |
| **Artist Similarity** | `/api/similar_artists` | GET | ✅ Exists |
| **Artist Tracks** | `/api/artist_tracks` | GET | ✅ Exists |
| **Song Alchemy** | `/api/alchemy` | POST | ✅ Exists |
| **Alchemy 2D Map** | `/api/artist_projections` | GET | ✅ Exists (optional) |
| **Save to Playlist** | `/api/create_playlist` (voyager) or `/chat/api/create_playlist` | POST | ✅ Exists |

---

## 1. Instant Playlist

**Endpoint**: `POST /chat/api/chatPlaylist`  
**Body**: `{ userInput: string, ai_provider?: string, ... }`  
**Response**: `{ response: { query_results: [{ item_id, title, artist }] } }`

**Feasibility**: ✅ Already implemented in Lidifin (MoodMixer). Uses mood → prompt mapping.

**Note**: The chat blueprint has `url_prefix='/chat'`, so the full path is `/chat/api/chatPlaylist`. Verify `audioMuseService.ts` uses the correct URL (base + `/chat/api/chatPlaylist`).

---

## 2. Playlist from Similar Song

**Endpoint**: `GET /api/similar_tracks`  
**Params**:
- `item_id` (Jellyfin item ID) **OR** `title` + `artist`
- `n` (default 10) – number of results
- `eliminate_duplicates` (optional) – limit songs per artist
- `mood_similarity` (optional) – filter by mood
- `radius_similarity` (optional)

**Response**: Array of `{ item_id, title, author, album, distance }`

**Feasibility**: ✅ Full API. Lidifin can:
1. Add "Find similar" on track context menu or track detail
2. Call `GET {audiomuseUrl}/api/similar_tracks?item_id={jellyfinId}` (strip `jellyfin:` prefix)
3. Map `item_id` → `jellyfin:itemId`, resolve tracks, render in Lidifin TrackList

**Auxiliary**: `GET /api/search_tracks?title=&artist=` for autocomplete when user searches by title/artist instead of selecting a track.

---

## 3. Artist Similarity

**Endpoint**: `GET /api/similar_artists`  
**Params**:
- `artist` (name) **OR** `artist_id` (Jellyfin artist ID)
- `n` (default 10) – number of similar artists
- `ef_search` (optional) – HNSW accuracy
- `include_component_matches` (optional)

**Response**: Array of `{ artist, artist_id, divergence, component_matches? }`

**Endpoint**: `GET /api/artist_tracks`  
**Params**: `artist` or `artist_id`  
**Response**: Array of `{ item_id, title, author }` – tracks by that artist

**Feasibility**: ✅ Full API. Lidifin can:
1. Add "Songs from similar artists" on artist page
2. Call `GET /api/similar_artists?artist_id={jellyfinArtistId}` (or `artist={name}`)
3. For each similar artist, optionally fetch tracks via `/api/artist_tracks`
4. Or: use similar artists to build a "discovery" playlist by sampling tracks from each
5. Render in Lidifin UI (artist cards, track list)

**ID mapping**: AudioMuse-AI uses Jellyfin item IDs. Lidifin artist IDs are `jellyfin:xxx` for Jellyfin artists. Pass the raw UUID (without `jellyfin:` prefix) as `artist_id`.

---

## 4. Song Alchemy

**Endpoint**: `POST /api/alchemy`  
**Body**:
```json
{
  "items": [
    { "id": "jellyfin-item-id", "op": "ADD", "type": "song" },
    { "id": "jellyfin-item-id", "op": "SUBTRACT", "type": "song" },
    { "id": "artist-id", "op": "ADD", "type": "artist" }
  ],
  "n": 100,
  "temperature": 1.0,
  "subtract_distance": 0.5
}
```

**Response**: `{ results: [...], filtered_out?: [...], centroid projections? }` – array of track objects with `item_id`, `title`, `author`, etc.

**Endpoint**: `GET /api/artist_projections`  
**Response**: `{ components: [{ artist_id, artist_name, projection: [x, y] }], count }` – for 2D map visualization

**Feasibility**: ✅ Full API. Lidifin can:
1. New page `/vibe/alchemy` or modal
2. Track list with ADD / SUBTRACT buttons per track
3. Optional artist search with ADD / SUBTRACT
4. "Generate" button → `POST /api/alchemy` with current items
5. Render results in Lidifin TrackList
6. Optional: 2D map using `projection` data if returned, or `/api/artist_projections` for artist-space visualization (may need to adapt for song-level)

**ID format**: Use Jellyfin item IDs (no `jellyfin:` prefix) in the `id` field.

---

## 5. Save to Playlist

**Endpoint** (Voyager): `POST /api/create_playlist`  
**Body**: `{ playlist_name: string, track_ids: string[] }`  
**Response**: `{ message, playlist_id }`

**Endpoint** (Chat): `POST /chat/api/create_playlist`  
**Body**: `{ playlist_name: string, item_ids: string[] }`

**Feasibility**: ✅ Either endpoint creates a playlist in Jellyfin. Lidifin can:
- Add "Save to playlist" after any generated result (Instant, Similar Song, Artist Similarity, Alchemy)
- Call AudioMuse-AI's create_playlist with the `item_id`s
- Or use Lidifin's own `POST /playlists` + add items (already syncs to Jellyfin)

---

## Implementation Effort Estimate

| Feature | Backend (Lidifin proxy) | Frontend UI | Effort |
|---------|-------------------------|-------------|--------|
| Instant Playlist | Done | Done (MoodMixer) | ✅ Complete |
| Similar Song | 1–2 hrs | 2–3 hrs (context menu + results view) | Low |
| Artist Similarity | 1–2 hrs | 2–4 hrs (artist page section) | Low–Medium |
| Song Alchemy | 2–3 hrs | 4–6 hrs (new page/modal, ADD/SUBTRACT) | Medium |
| Save to Playlist | 1 hr | 1 hr (button + name dialog) | Low |

**Total**: ~15–20 hours for all four features + Save.

---

## Requirements & Gotchas

1. **URL paths**: Chat routes use `/chat` prefix. Confirm `audioMuseService` uses `{baseUrl}/chat/api/chatPlaylist` not `{baseUrl}/api/chatPlaylist`.

2. **ID format**: AudioMuse-AI expects raw Jellyfin UUIDs. Lidifin uses `jellyfin:uuid`. Strip the prefix when calling AudioMuse-AI; add it back when resolving for playback.

3. **CORS**: AudioMuse-AI must allow Lidifin's origin if the frontend calls it directly. Safer: proxy all calls through Lidifin backend (recommended).

4. **Auth**: AudioMuse-AI does not appear to require auth for these APIs. Lidifin backend proxies requests, so no extra auth needed.

5. **Analysis state**: Similar Song, Artist Similarity, and Song Alchemy depend on AudioMuse-AI having run analysis and clustering. If the library is not analyzed, endpoints may return 404 or empty results.

---

## Recommended Architecture

```
[Lidifin Frontend] 
    → [Lidifin Backend] (proxy, add auth, map IDs)
        → [AudioMuse-AI] (HTTP API)
```

- Lidifin backend adds routes like `/api/audiomuse/similar-tracks`, `/api/audiomuse/similar-artists`, `/api/audiomuse/alchemy`
- Backend calls AudioMuse-AI, maps `item_id` ↔ `jellyfin:itemId`, resolves tracks
- Frontend only talks to Lidifin API; no CORS or AudioMuse-AI URL exposure

---

*Report based on AudioMuse-AI source code (app.py, app_voyager.py, app_artist_similarity.py, app_alchemy.py, app_chat.py). Last verified: Feb 2025.*
