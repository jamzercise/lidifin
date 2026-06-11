# Lidifin Mobile API v1

This document defines the first-class backend contract for a native mobile app.

It does not mean every existing Lidifin endpoint is frozen for mobile use. It
does mean the flows and endpoints listed here are the ones a mobile client
should build against first.

## Machine-Readable Spec

The canonical machine-readable OpenAPI artifact for this contract lives at:

- repo file: `backend/src/config/mobileOpenApi.json`
- running server endpoint: `/api/docs/mobile.json`
- human-browsable Swagger UI: `/api/docs/mobile`

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

### Search

- `GET /search?q=...`

### Playback and streaming

- `GET /library/tracks/{id}/stream`

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

These backend areas exist, but are not yet declared part of the stable mobile
contract:

- offline download lifecycle
- playback-state sync
- mixes/discover/recommendation flows
- full admin/settings management

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
