# AudioMuse-AI Integration Plan

Plan for integrating AudioMuse-AI with Lidifin to recreate and enhance the Vibes system.

**Context**: Lidifin's music library is **Jellyfin-only** – all artists, albums, and tracks come from Jellyfin. The "Music" folder in the UI is for where downloads are sent, not the library source.

---

## 1. Research Summary

### AudioMuse-AI Overview

- **What it is**: Open-source, Dockerized environment for automatic playlist generation from self-hosted music libraries
- **Tech stack**: Flask, Redis Queue, PostgreSQL, Librosa, ONNX, CLAP (Contrastive Language-Audio Pretraining)
- **Integrations**: Jellyfin, Navidrome, LMS, Lyrion, Emby
- **Key features**:
  - **Instant Playlists**: Natural language → playlist (e.g. "high-tempo, low-energy music")
  - **Clustering**: Groups sonically similar songs
  - **Text Search**: Search by mood, instruments, genre (e.g. "calm piano songs")
  - **Song Similarity**: Find tracks similar to a given song
  - **Music Map**: 2D visual exploration
  - **Song Alchemy**: Mix vibes with ADD/SUBTRACT
  - **Sonic Fingerprint**: Playlists from listening habits

### Deployment Requirements

**Both components are required** for the AudioMuse-AI integration to work:

1. **AudioMuse-AI instance** (Docker) – The core application that performs sonic analysis and playlist generation. Lidifin calls its HTTP API for instant playlists.
2. **AudioMuse-AI Jellyfin plugin** – Installed in Jellyfin to analyze the library and populate the database that the standalone instance uses.

Without the plugin, AudioMuse-AI has no analyzed library to query. Without the standalone instance, Lidifin has no API to call. Both must be running and configured.

### AudioMuse-AI API (Relevant Endpoints)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/chatPlaylist` | POST | `userInput` (text) → AI generates playlist. Returns `query_results` with `item_id`, `title`, `artist`. Requires AI provider (OLLAMA, GEMINI, OPENAI, MISTRAL). |
| `/api/create_playlist` | POST | `playlist_name`, `item_ids` → Creates playlist on media server (Jellyfin) |
| `/external/search` | GET | `title`, `artist` → Autocomplete for tracks |
| `/external/get_embedding` | GET | `id` → Embedding vector for track |
| `/external/get_score` | GET | `id` → Score data for track |

**Primary integration point**: `POST /api/chatPlaylist` for mood/vibe → playlist generation.

---

## 2. Current Lidifin Vibes System

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **MoodMixer** | `frontend/components/MoodMixer.tsx` | Modal with 9 mood tiles (happy, sad, chill, etc.). Calls `getMoodBucketMix(mood)` → play |
| **Vibe Page** | `frontend/app/vibe/page.tsx` | Text search via CLAP, presets, similar tracks |
| **Mood Buckets** | `backend/src/services/moodBucketService.ts` | Pre-computed mood assignments. Tracks assigned during analysis. |
| **Vibe Routes** | `backend/src/routes/vibe.ts` | `/vibe/similar/:trackId`, `/vibe/search` (CLAP text), `/vibe/status` |
| **Mixes Routes** | `backend/src/routes/mixes.ts` | `/mixes/mood`, `/mixes/mood/buckets/:mood`, `/mixes/mood/buckets/presets` |
| **CLAP Analyzer** | `services/audio-analyzer-clap/` | Redis pub/sub for text embeddings. Populates `track_embeddings`. |

### Data Flow (Current)

1. **MoodMixer**: User picks mood → `GET /mixes/mood/buckets/:mood` → `moodBucketService.getMoodMix()` → returns track IDs from `MoodBucket` table → resolve to full tracks → play
2. **Vibe Search**: User enters text → `POST /vibe/search` → Redis request to CLAP analyzer for text embedding → pgvector similarity search on `track_embeddings` → return tracks
3. **Similar Tracks**: `GET /vibe/similar/:trackId` → hybrid similarity (CLAP + audio features)

### Library Architecture (Lidifin)

- **The entire music library comes from Jellyfin only.** There is no native/local library. All artists, albums, and tracks are pulled from Jellyfin.
- The "Music" folder in the UI is the **download destination** (where Soulseek, Lidarr, etc. save files), not the library source.
- **AudioMuse-AI analyzes Jellyfin's library directly** – it uses Jellyfin item IDs natively, which aligns with Lidifin's Jellyfin-only architecture.

---

## 3. Integration Architecture

### Integration Flow

When **AudioMuse-AI is configured** (both the standalone instance and Jellyfin plugin running):

1. User selects mood or enters vibe text in MoodMixer / Vibe page
2. Lidifin backend calls AudioMuse-AI `POST /api/chatPlaylist` with:
   - `userInput`: "energetic rock music" or mood-specific prompt
   - `ai_provider`: from system settings (optional)
3. AudioMuse-AI returns `query_results` with `item_id` (Jellyfin ID)
4. Lidifin maps `item_id` → `jellyfin:itemId` and resolves tracks via `resolveTrackReferences`
5. Return tracks to frontend for playback

Since the library is Jellyfin-only, AudioMuse-AI (which analyzes Jellyfin's library) is the primary path for mood-based playlists.

### Data Flow (New)

```
User: "Chill acoustic vibes"
    ↓
[Lidifin Frontend] MoodMixer or Vibe page
    ↓
[Lidifin Backend] POST /mixes/audiomuse/instant
    ↓
[Lidifin] calls AudioMuse-AI POST /api/chatPlaylist
    body: { userInput: "chill acoustic relaxing" }
    ↓
[AudioMuse-AI] MCP tools → search_database, etc. → returns item_ids
    ↓
[Lidifin] Map item_ids → jellyfin:itemId
    ↓
[Lidifin] resolveTrackReferences() → full track objects
    ↓
[Frontend] playTracks(tracks)
```

---

## 4. Implementation Steps

### Phase 1: System Settings & Service

1. **Add AudioMuse-AI settings** to `SystemSettings` (prisma):
   - `audiomuseEnabled: Boolean`
   - `audiomuseUrl: String?` (e.g. `http://audiomuse:8000`)
   - `audiomuseAiProvider: String?` (OLLAMA, GEMINI, OPENAI, MISTRAL, NONE)
   - `audiomuseApiKey: String?` (if required for API access)

2. **Create `AudioMuseService`** (`backend/src/services/audioMuseService.ts`):
   - `generateInstantPlaylist(userInput: string): Promise<{ itemIds: string[] }>`
   - Calls `POST {audiomuseUrl}/api/chatPlaylist` with `userInput`
   - Parses `response.response.query_results` → extract `item_id`
   - Returns array of Jellyfin item IDs

3. **Mood → prompt mapping**: Map Lidifin mood types to AudioMuse prompts:
   - happy → "happy upbeat cheerful"
   - chill → "chill relaxed calm ambient"
   - energetic → "energetic powerful intense"
   - etc.

### Phase 2: Backend Endpoints

4. **New route** `POST /mixes/audiomuse/instant`:
   - Body: `{ userInput?: string, mood?: MoodType }`
   - If `mood` provided, use preset prompt; else use `userInput`
   - Call AudioMuseService
   - Map item_ids → `jellyfin:itemId`
   - Resolve tracks via `resolveTrackReferences`
   - Return `{ tracks: ResolvedTrack[] }`

5. **Optional**: `GET /mixes/audiomuse/status` – check if AudioMuse-AI is reachable

### Phase 3: Frontend Integration

6. **MoodMixer enhancement**:
   - When AudioMuse enabled: use `POST /mixes/audiomuse/instant` with `mood`
   - Fallback to mood buckets (if available) when AudioMuse unavailable or disabled

7. **Vibe page enhancement**:
   - Add "Instant Playlist" option that calls `/mixes/audiomuse/instant` with user's text input
   - Show result and allow play

8. **Settings UI**: Add AudioMuse-AI configuration section (URL, API key if needed)

### Phase 4: Docker & Deployment

9. **docker-compose**: Add optional `audiomuse` service (or document as user-added)
10. **Documentation**: Update README with AudioMuse-AI setup instructions. **Requirement**: Users must run both the AudioMuse-AI Docker instance and install the AudioMuse-AI Jellyfin plugin.

---

## 5. Mood → AudioMuse Prompt Mapping

| Lidifin Mood | AudioMuse Prompt |
|--------------|------------------|
| happy | happy upbeat cheerful bright positive |
| sad | sad melancholic emotional |

| chill | chill relaxed calm ambient peaceful mellow |
| energetic | energetic powerful intense driving upbeat |
| party | party danceable groovy upbeat fun |
| focus | instrumental calm focus concentration |
| melancholy | melancholic bittersweet reflective nostalgic |
| aggressive | aggressive intense powerful heavy |
| acoustic | acoustic organic unplugged guitar |

---

## 6. Error Handling

- AudioMuse-AI unreachable → fallback to mood buckets if available, otherwise show "Service unavailable"
- AI provider NONE or missing API key → return error with setup instructions
- Empty results → return friendly message

---

## 7. Future Enhancements

- **Save to playlist**: Use AudioMuse-AI `POST /api/create_playlist` or Lidifin's own playlist creation with Jellyfin sync
- **Song Alchemy**: Expose AudioMuse-AI's Song Alchemy UI or replicate via API
- **CLAP-only search**: If AudioMuse-AI exposes a simpler text search (no AI), use that for lower latency

---

*Last updated: Feb 2025*
