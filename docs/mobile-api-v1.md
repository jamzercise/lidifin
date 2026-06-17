# Lidifin Mobile API v1

This document defines the first-class backend contract for a native mobile app.

It does not mean every existing Lidifin endpoint is frozen for mobile use. It
does mean the flows and endpoints listed here are the ones a mobile client
should build against first.

## Machine-Readable Spec

The canonical machine-readable OpenAPI artifact lives at:

- repo file: `backend/src/config/mobileOpenApi.json`
- running server endpoint: `/api/docs/mobile.json`
- human-browsable Swagger UI: `/api/docs/mobile`

As of this revision the spec is a **complete reference for every backend
endpoint** (~290 operations across the whole system), not just a curated mobile
subset. Coverage is two-tiered:

- **Core mobile flows** (auth, library browse, search, streaming, playlists,
  audiobooks, podcasts, radio) carry fully detailed request/response schemas.
- **All remaining endpoints** (admin, enrichment, analysis, discovery, system
  settings, integrations, webhooks, etc.) document path, method, authentication,
  and path parameters with generic response shapes. Endpoints that require admin
  privileges say so in their description.

If you are feeding Lidifin docs into an AI system or a code generator, prefer
the JSON spec over this Markdown file. Use this Markdown document as supporting
context for intent and client-behavior guidance.

## Goals

- Use username/password as the primary sign-in flow.
- Support secure long-running playback sessions with refresh tokens.
- Support native streaming with seek via HTTP Range requests.
- Keep device-link and API keys as optional secondary flows, not the primary
  interactive login path.

## Base URL

All paths in this document are relative to the Lidifin API base path:

`https://your-lidifin-host/api`

Examples:

- `https://music.example.com/api/auth/login`
- `https://music.example.com/api/library/artists`
- `https://music.example.com/api/library/tracks/{id}/stream`

## Official Authentication Model

### Primary flow: username/password -> JWT access + refresh

Use this for the normal Android login experience.

1. `POST /auth/login`
2. Store:
   - `token` as the Bearer access token
   - `refreshToken` as the refresh token
3. Send `Authorization: Bearer <token>` on API requests
4. On `401`, attempt `POST /auth/refresh`
5. If refresh fails, require the user to log in again

This is the preferred auth path for mobile.

### Optional paired-device flow: device link

Use this only when the user signs in somewhere else first and wants to link a
device with a short code.

1. Signed-in user creates a code with `POST /device-link/generate`
2. Another device polls `GET /device-link/status/{code}`
3. Another device exchanges the code via `POST /device-link/verify`
4. The verification response returns an API key for that paired device

### Secondary auth: API keys

API keys remain supported for paired devices and long-lived integrations.

They are not the primary mobile sign-in method.

Send them as:

`X-API-Key: <key>`

## Mobile-Supported Endpoint Set

### Authentication

- `POST /auth/login`
- `POST /auth/refresh`
- `GET /auth/me`

### Device linking and paired devices

- `POST /device-link/generate`
- `POST /device-link/verify`
- `GET /device-link/status/{code}`
- `GET /device-link/devices`
- `DELETE /device-link/devices/{id}`
- `POST /api-keys`
- `GET /api-keys`
- `DELETE /api-keys/{id}`

### Library browse

- `GET /library/artists`
- `GET /library/albums`
- `GET /library/tracks`

### Playlists

- `GET /playlists`
- `POST /playlists`
- `GET /playlists/{id}`
- `PUT /playlists/{id}`
- `DELETE /playlists/{id}`
- `GET /playlists/{id}/cover`
- `POST /playlists/{id}/items`
- `DELETE /playlists/{id}/items/{trackId}`
- `PUT /playlists/{id}/items/reorder`

### Search

- `GET /search?q=...`

### Playback and streaming

- `GET /library/tracks/{id}/stream`

### Audiobooks

Backed by an external Audiobookshelf server. When Audiobookshelf is not
configured, list endpoints return empty results (and `GET /audiobooks` returns
`{ "configured": false, "enabled": false, "audiobooks": [] }` instead of an
array).

- `GET /audiobooks`
- `GET /audiobooks/search?q=...`
- `GET /audiobooks/{id}`
- `GET /audiobooks/{id}/cover` (no auth required)
- `GET /audiobooks/{id}/stream`
- `POST /audiobooks/{id}/progress`
- `DELETE /audiobooks/{id}/progress`

### Podcasts

- `GET /podcasts`
- `GET /podcasts/{id}`
- `POST /podcasts/subscribe`
- `DELETE /podcasts/{id}/unsubscribe`
- `GET /podcasts/new-episodes`
- `GET /podcasts/continue-listening`
- `GET /podcasts/discover/top`
- `GET /podcasts/{podcastId}/episodes/{episodeId}/stream`

### Radio

Core radio (always available):

- `GET /library/radio?type=...` (returns `{ tracks }`)
- `GET /library/genres` (genre stations)
- `GET /library/decades` (decade stations)
- `GET /library/vibes` (mood/vibe stations)

AI-powered radio (only when AudioMuse-AI is enabled and reachable; requires
Jellyfin as the music source):

- `GET /mixes/audiomuse/status`
- `POST /mixes/audiomuse/instant`
- `GET /mixes/audiomuse/similar-tracks?trackId=...`
- `GET /mixes/audiomuse/similar-artists?artistId=...`
- `GET /mixes/audiomuse/artist-tracks?artistId=...`
- `POST /mixes/audiomuse/alchemy`
- `POST /mixes/audiomuse/save-playlist`

## Request/Response Notes

### `POST /auth/login`

Request body:

```json
{
  "username": "alice",
  "password": "secret"
}
```

Success response:

```json
{
  "token": "<access-token>",
  "refreshToken": "<refresh-token>",
  "user": {
    "id": "user-id",
    "username": "alice",
    "role": "user"
  }
}
```

If two-factor auth is enabled, successful password validation may instead return:

```json
{
  "requires2FA": true,
  "message": "2FA token required"
}
```

In that case, retry `/auth/login` with the same username/password and a `token`
 field containing the TOTP or recovery code.

### `POST /auth/refresh`

Request body:

```json
{
  "refreshToken": "<refresh-token>"
}
```

Response:

```json
{
  "token": "<new-access-token>",
  "refreshToken": "<new-refresh-token>"
}
```

### `GET /auth/me`

Use this after login or app resume to validate that the current auth still maps
to a real user.

### `GET /library/artists`

Important query params:

- `query`
- `limit`
- `offset`
- `cursor`
- `filter=owned|discovery|all`
- `sortBy`

### `GET /library/albums`

Important query params:

- `artistId`
- `limit`
- `offset`
- `filter=owned|discovery|all`
- `sortBy`

### `GET /library/tracks`

Important query params:

- `albumId`
- `limit`
- `offset`
- `sortBy`

### `GET /search`

Required query param:

- `q`

Useful query param:

- `type=all|artists|albums|tracks|audiobooks|podcasts|episodes`

### Audiobooks and podcasts

- Audiobook and podcast media are separate from the music library and live
  under `/audiobooks` and `/podcasts` respectively.
- Both accept the same auth as the rest of the mobile API (Bearer JWT preferred,
  `X-API-Key` also supported).
- Cover images are served as relative paths (e.g. `/audiobooks/{id}/cover`,
  `/podcasts/{id}/cover`); resolve them against the API base URL.
- Progress is per-user. Audiobooks expose `POST/DELETE /audiobooks/{id}/progress`;
  podcast progress is reflected in the `progress` field on episodes.
- Episode and audiobook streaming supports HTTP Range the same way track
  streaming does.

### Radio

- `GET /library/radio` requires a `type` (one of `discovery`, `favorites`,
  `decade`, `genre`, `mood`, `workout`, `artist`, `vibe`). `value` carries the
  station selector (decade year, genre/mood name, artist ID for `artist`, or a
  source track ID for `vibe`). Response is `{ tracks }`, plus `sourceFeatures`
  for `vibe`.
- Radio tracks place `artist` at the top level (not nested under `album`), which
  differs from `GET /library/tracks`.
- The `/mixes/audiomuse/*` endpoints depend on an optional external service
  (AudioMuse-AI) and require Jellyfin as the music source. Gate the AI radio UI
  on `GET /mixes/audiomuse/status` returning `enabled: true` and
  `available: true`.
- `POST /mixes/audiomuse/instant` can take minutes; use a long client timeout
  (the web app allows ~2-3 minutes) and show a progress state.

### Playlists

- `GET /playlists` returns summaries with `trackCount` but no track list; fetch
  `GET /playlists/{id}` for the resolved items.
- Track IDs in add/remove/reorder may be native IDs or `jellyfin:`-prefixed IDs,
  consistent with the rest of the API.
- Mutations (`POST`/`PUT`/`DELETE`) are owner-only and return `403` otherwise;
  private playlists owned by others return `403` on read as well.
- When Jellyfin is the source, playlists are bi-directionally synced, so reads
  reflect Jellyfin and writes propagate to it.
- Playlist detail may also include `pendingTracks` (unresolved Spotify imports)
  and a `mergedItems` array; a mobile client can ignore these for basic playback.

## Streaming Contract

### Endpoint

`GET /library/tracks/{id}/stream`

### Authentication

Preferred:

- `Authorization: Bearer <token>`

Also supported:

- `X-API-Key: <key>`
- `?token=<jwt>` for stream contexts that cannot attach headers easily

### Query params

- `quality=original|high|medium|low`

### Range requests

The endpoint supports HTTP Range requests for seeking.

Mobile clients should:

- send `Range` when resuming or seeking
- handle both `200 OK` and `206 Partial Content`
- preserve `Content-Range`, `Content-Length`, and `Accept-Ranges`

### Jellyfin-backed behavior

When the track source is Jellyfin:

- Lidifin may proxy the stream itself, or
- Lidifin may return a `302` redirect to Jellyfin

A native client should follow redirects and should treat `503` as an upstream
media-source failure rather than a malformed request.

## Error-Handling Guidance

### `401 Unauthorized`

- Access token expired
- Refresh token should be attempted once
- If refresh fails, return to sign-in

### `403 Forbidden`

- Authenticated, but lacks required privileges
- Most relevant for admin-only routes

### `404 Not Found`

- Resource does not exist
- Device link code invalid
- Track or album no longer available

### `429 Too Many Requests`

- Respect retry/backoff behavior
- Avoid aggressive polling loops

### `503 Service Unavailable`

Usually means an upstream dependency is unavailable, especially Jellyfin.

Clients should present this as a temporary playback/library outage and allow
retry.

## Current Non-Goals for Mobile v1

All backend endpoints are now present in the OpenAPI spec, but the following
areas are documented at the path/method/auth level rather than with detailed,
stability-guaranteed schemas. Treat them as available-but-evolving for mobile:

- offline download lifecycle
- playback-state sync
- discover/recommendation flows beyond radio
- admin/settings/system management
- enrichment, audio analysis, and integration (Lidarr/Soulseek/Spotify) controls

They can be added later once the core browse/search/stream experience is solid.

## Practical Android Recommendations

- Use Bearer auth as the default for all authenticated requests.
- Treat API keys as paired-device credentials, not as the main login path.
- Build the playback engine assuming:
  - Range requests are available
  - redirects may occur
  - upstream media failures may surface as `503`
- Use the OpenAPI docs as reference, but treat this document as the mobile
  contract for the first Android iteration.
