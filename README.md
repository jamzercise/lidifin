# Lidifin

[![Docker Image](https://img.shields.io/docker/v/jamzercise/lidifin?label=Docker&sort=semver)](https://hub.docker.com/r/jamzercise/lidifin)
[![GitHub Release](https://img.shields.io/github/v/release/jamzercise/lidifin?label=Release)](https://github.com/jamzercise/lidifin/releases)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

**A Spotify-style streaming front end for your Jellyfin music library.**

Lidifin points at your existing Jellyfin server and turns it into a modern on-demand music player: personalized mixes, radio stations, vibe-based discovery, playlist import, podcasts, and audiobooks — all in one self-hosted container. Your library stays in Jellyfin; Lidifin adds the listening experience on top of it.

![Lidifin Home Screen](assets/screenshots/desktop-home.png)

> **Relationship to Lidify.** Lidifin began as a fork of [Lidify](https://github.com/Chevron7Locked/lidify), which scans a local music folder. Lidifin re-architected the library layer so that **Jellyfin is the authoritative source** for artists, albums, tracks, favorites, and playback. The two projects have diverged significantly; features and configuration described here apply to Lidifin only.

---

## Table of Contents

- [How Lidifin Works](#how-lidifin-works)
- [Features](#features)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Jellyfin Setup](#jellyfin-setup)
- [Audio Analysis and the Vibe System](#audio-analysis-and-the-vibe-system)
- [Integrations](#integrations)
- [Using Lidifin](#using-lidifin)
- [Administration](#administration)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [License](#license)

---

## How Lidifin Works

Lidifin ships as a **single all-in-one Docker container**. That container runs the web frontend, the API backend, a background worker, PostgreSQL, and Redis. You expose one port and mount one data volume.

Your **music library lives in Jellyfin**. Lidifin queries Jellyfin for artists, albums, and tracks, and streams audio from it. PostgreSQL stores only Lidifin's own state — users, playlists, play history, discovery batches, download jobs — plus two cache tables that mirror Jellyfin track metadata and audio analysis so recommendation queries stay fast. This split is documented in [ADR 0001](adr/0001-jellyfin-authoritative-library.md) and [ADR 0003](adr/0003-prisma-metadata-not-content-mirror.md).

What this means in practice:

- **You do not mount your music into Lidifin for playback.** Streaming goes through Jellyfin.
- **Your browser or device must be able to reach your Jellyfin URL**, since playback is redirected there.
- **Adding music is Jellyfin's job.** When Lidifin downloads new music, it writes to a folder you also have Jellyfin indexing.
- **Deleting the Lidifin data volume loses your Lidifin playlists and history, not your music.**

A legacy local-files mode still exists in the codebase and is used for development, but the published image is Jellyfin-first and does not bundle the local audio analyzers. See [Audio Analysis](#audio-analysis-and-the-vibe-system).

---

## Features

### Library and Playback

- **Jellyfin library** — artists, albums, and tracks come straight from Jellyfin, with batched lookups and Redis caching so large libraries stay responsive
- **Streaming** — plays FLAC, MP3, AAC, OGG, and other formats Jellyfin serves; quality and transcoding are configurable in Settings
- **Favorites** — the heart icon writes through to Jellyfin, so favorites stay in sync both directions
- **Playlists** — two-way sync with Jellyfin playlists, including reordering and edits made on either side
- **Gapless-style preloading** — the next track is preloaded during playback for fast transitions
- **Chromecast** — cast to any Default Media Receiver device on your network
- **Queue** — Spotify-style "Up Next" insertion, drag-to-reorder, shuffle, and repeat modes
- **Resume across devices** — playback position and queue are saved server-side

<p align="center">
  <img src="assets/screenshots/desktop-library.png" alt="Library View" width="800">
</p>

### Discovery

- **Discover Weekly** — a weekly playlist of music you don't own yet, generated from your listening history and acquired through Lidarr or Soulseek. Runs automatically on Sunday evenings or on demand.
- **Two acquisition modes** — request **full albums** or **individual songs**. Track-first mode ([ADR 0007](adr/0007-track-first-discover.md)) grabs single songs and can upgrade to the full album if you keep the track.
- **Discover shelves** — additional entry points below Discover Weekly: new releases, mood exploration, hidden gems, artists for you, and external playlists
- **Made For You mixes** — era mixes, genre mixes, top tracks, and rediscovery mixes built from your library
- **Library radio** — one-click stations including Shuffle All, Workout, Discovery, and Favorites, plus dynamic genre and decade stations
- **Release Radar** — upcoming and recent releases from artists you follow
- **Artist recommendations** — similar artists via Last.fm, with alias resolution (typing "of mice" finds "Of Mice & Men")
- **Deezer previews** — hear a track before you add it to your library

### The Vibe System

While playing anything, activate vibe mode to queue tracks that feel like the current one.

- **Vibe button** in the player queues matching tracks continuously
- **Radar chart** comparing energy, mood, groove, and tempo against the source track
- **Mood Mixer** — build a playlist by picking a mood tile or adjusting sliders
- **Song Alchemy** — add and subtract songs and artists to steer a generated mix
- **Text search** — describe a vibe in words and get matching tracks

Vibe data comes from Jellyfin's [AudioMuse AI](https://github.com/NeptuneHub/AudioMuse-AI) plugin. See [Audio Analysis](#audio-analysis-and-the-vibe-system) for setup.

<p align="center">
  <img src="assets/screenshots/vibe-overlay.png" alt="Vibe Overlay" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/mood-mixer.png" alt="Mood Mixer" width="800">
</p>

### Playlist Import

Bring playlists in from Spotify, Deezer, or YouTube Music. Lidifin previews the track list, shows you what you already own, what it can download, and what it can't find, and lets you choose what to acquire.

- **Spotify** and **Deezer** — paste a playlist URL, or browse Deezer's featured playlists in-app
- **YouTube Music** — paste a playlist URL to preview and import; the container bundles `yt-dlp`
- **Selective download** — pick exactly which albums or tracks to add
- **Progress in the Activity Panel** — track imports as they run

<p align="center">
  <img src="assets/screenshots/spotify-import-preview.png" alt="Import Preview" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/deezer-browse.png" alt="Browse Deezer" width="800">
</p>

### Podcasts and Audiobooks

- **Podcasts** — search iTunes and Podcast Index, subscribe via RSS, stream episodes directly, and keep your position synced across devices
- **Audiobooks** — connect an Audiobookshelf instance to browse, stream, and sync progress alongside your music
- **±30s skip controls** on mobile for both

<p align="center">
  <img src="assets/screenshots/desktop-podcasts.png" alt="Podcasts" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/desktop-audiobooks.png" alt="Audiobooks" width="800">
</p>

### Multi-User and Devices

- **Separate accounts** — each user gets their own playlists, history, favorites, and preferences. The first account created becomes the administrator.
- **Two-factor authentication** — TOTP with recovery codes
- **API keys** — for programmatic access, with a dedicated mobile API surface documented at `/api/docs/mobile`
- **Device linking** — pair a phone or TV by scanning a QR code instead of typing credentials
- **Progressive Web App** — installable on Android and iOS with lock-screen media controls and background playback
- **Android TV** — a separate 10-foot interface with full D-pad and remote navigation, activated automatically on TV devices

<p align="center">
  <img src="assets/screenshots/mobile-home.png" alt="Mobile Home" width="260">
  <img src="assets/screenshots/mobile-player.png" alt="Mobile Player" width="260">
  <img src="assets/screenshots/mobile-library.png" alt="Mobile Library" width="260">
</p>

---

## Quick Start

You need a running **Jellyfin server with a music library** and a Jellyfin **API key**. See [Jellyfin Setup](#jellyfin-setup).

For step-by-step instructions including Dockge, see the [Installation guide](docs/INSTALL.md).

### Docker run

```bash
docker run -d \
  --name lidifin-player \
  -p 31013:3030 \
  -v lidifin_data:/data \
  -e TZ=America/New_York \
  --add-host=host.docker.internal:host-gateway \
  jamzercise/lidifin:latest
```

Open `http://localhost:31013` and create your account. The setup wizard walks you through connecting Jellyfin.

If you also want Lidifin to download music, mount the folder Jellyfin indexes so new files get picked up:

```bash
  -v /path/to/your/music:/music \
```

### Docker Compose

Copy [`docker-compose.prod.yml`](docker-compose.prod.yml) to your stack directory as `compose.yaml`, create a `.env` beside it, and deploy:

```env
# Where downloads land — should be a folder Jellyfin also indexes
MUSIC_PATH=/mnt/media/music

# Recommended: set these so they survive container recreation
SESSION_SECRET=<openssl rand -base64 32>
INTERNAL_API_SECRET=<openssl rand -hex 32>

PORT=31013
TZ=America/New_York
```

```bash
docker compose up -d
```

To update:

```bash
docker compose pull && docker compose up -d
```

> **Note on `--build`:** `docker-compose.prod.yml` builds from the GitHub repository, not your local checkout. To build from local source, use [`docker-compose.build.yml`](docker-compose.build.yml).

### What's in the container

| Component | Port | Exposure |
| --- | --- | --- |
| Frontend (Next.js) | 3030 | **Published** — map a host port to this |
| Backend API (Express) | 3006 | Loopback only |
| Background worker | — | Internal |
| PostgreSQL + pgvector | 5432 | Loopback only |
| Redis | 6379 | Loopback only |

Only the frontend is reachable from outside the container. It proxies `/api/*` to the backend internally.

### Release channels

**Stable** — tagged releases, recommended:

```bash
docker pull jamzercise/lidifin:latest
docker pull jamzercise/lidifin:v1.0.6   # or a specific version
```

**Nightly** — built on every push to `main`, may be unstable:

```bash
docker pull jamzercise/lidifin:nightly
```

Images are built for `linux/amd64`.

---

## Configuration

Most configuration happens in the web UI under **Settings**. Credentials you enter there are encrypted at rest. Environment variables cover deployment-level concerns only.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `TZ` | `UTC` | Container timezone |
| `PORT` | `31013` | Host port in the compose file; the container always listens on 3030 |
| `PUID` / `PGID` | `1000` | Runs the app processes as this user and group. Set these to whoever owns your music path so downloads can be written — see [Download permissions](#download-permissions). |
| `SESSION_SECRET` | Generated | Signs sessions and JWTs. Generated on first boot and persisted to `/data/secrets`. Set it explicitly if you run multiple replicas. |
| `SETTINGS_ENCRYPTION_KEY` | Generated | Encrypts stored credentials. Generated on first boot and persisted. **If you lose it, saved integration credentials cannot be decrypted.** |
| `INTERNAL_API_SECRET` | Generated | Authenticates the analysis worker callbacks |
| `JELLYFIN_API_KEY` | — | Overrides the API key stored in Settings |
| `LIDIFY_CALLBACK_URL` | `http://host.docker.internal:31013` | How Lidarr reaches Lidifin for download webhooks |
| `LOG_LEVEL` | `warn` | `debug`, `info`, `warn`, `error`, or `silent`. Use `info` to see library and Jellyfin request logs. |
| `DOCS_PUBLIC` | `false` | Set `true` to expose API docs without authentication |
| `ALLOWED_ORIGINS` | — | Comma-separated origins for CORS when behind a reverse proxy |
| `NEXT_PUBLIC_API_URL` | — | Set when the API is served from a different hostname than the UI |
| `ADMIN_RESET_PASSWORD` | — | Set, restart, then remove to reset the admin password |
| `REQUEST_TIMEOUT_MS` | `90000` | Maximum API handler duration |
| `DATABASE_POOL_SIZE` | `20` | Postgres connection pool size |
| `DATABASE_STATEMENT_TIMEOUT_SEC` | `30` | Cancels long-running queries |

**Secrets are generated automatically.** On first boot the container creates `SESSION_SECRET`, `SETTINGS_ENCRYPTION_KEY`, `INTERNAL_API_SECRET`, and the database password, then persists them under `/data/secrets`. Setting them explicitly in your environment takes precedence and is recommended for production so they're recorded in your own secret management.

### Volumes

| Path | Purpose |
| --- | --- |
| `/data` | PostgreSQL data, Redis persistence, generated secrets, cover art and transcode cache |
| `/music` | Optional. Download destination — point it at a folder Jellyfin indexes. |

### Download permissions

Streaming comes from Jellyfin, so Lidifin only needs to *write* to `/music` when it downloads music — Soulseek transfers, single-track grabs from artist pages, and the Singles organizer. Those writes happen as the unprivileged user the app runs as, which defaults to uid 1000.

If the folder you mount at `/music` is owned by a different account — which is normal, since it's usually owned by whatever runs Jellyfin or Lidarr — every download fails with `Cannot create destination directory: EACCES` while playback keeps working fine.

Check who owns it, using `-n` so you get raw numeric ids rather than names:

```bash
ls -ldn /path/to/your/music
# drwxrwx--- 1498 568 568 1786 Aug  7 14:05 /mnt/Data/MediaServer/Music
#                  ^^^ ^^^ owner and group
```

Then set `PUID` and `PGID` to match:

```env
PUID=568
PGID=568
```

Files Lidifin creates then have the same ownership as the ones Lidarr and Jellyfin already produce, so nothing else needs adjusting. The container verifies this at startup and prints a warning naming the exact ids if `/music` still isn't writable.

Granting access with an ACL instead also works, but it's more fragile: you have to remember the inherit flags so newly created album folders are covered, and ZFS datasets using `acltype=nfsv4` (the TrueNAS default) don't support POSIX `setfacl` at all. Matching `PUID`/`PGID` avoids all of that.

Named volumes are recommended. If you bind-mount `/data`, create the subdirectories first and make sure they're writable, because PostgreSQL and Redis run as their own users inside the container:

```bash
mkdir -p /path/to/lidifin-data/postgres /path/to/lidifin-data/redis
```

If startup logs report a permission error, `chown` the host path to the UID shown in the log.

### External access

Behind a reverse proxy, set both of these so the browser and the API agree on origins:

```env
NEXT_PUBLIC_API_URL=https://lidifin.yourdomain.com
ALLOWED_ORIGINS=https://lidifin.yourdomain.com
```

Remember that playback redirects to Jellyfin, so remote clients need a reachable Jellyfin URL too.

---

## Jellyfin Setup

1. In Jellyfin, go to **Dashboard → API Keys** and create a key.
2. In Lidifin, open **Settings → Jellyfin (Music)**, or complete the Jellyfin step during onboarding.
3. Enter your Jellyfin URL — for example `http://192.168.1.50:8096` or your public HTTPS URL.
4. Paste the API key and click **Test connection**.
5. Enable **Use Jellyfin for music** and save.

Use a URL your **clients** can reach, not just one the container can reach, since audio streams are redirected to Jellyfin.

For details on playlist sync, metadata enrichment, and genre radio behavior, see [docs/JELLYFIN.md](docs/JELLYFIN.md).

---

## Audio Analysis and the Vibe System

Vibe matching, mood mixes, and similarity search need per-track analysis data: BPM, key, energy, mood, and embeddings.

**In the published image, this comes from Jellyfin.** Install the [AudioMuse AI](https://github.com/NeptuneHub/AudioMuse-AI) plugin in Jellyfin, let it analyze your library, then configure it in **Settings → AudioMuse**. Lidifin reads the results and caches them in its `JellyfinTrackAnalysis` table, as described in [ADR 0002](adr/0002-jellyfin-track-analysis-storage.md).

Vibe features stay hidden until analysis data is available, so an unanalyzed library simply won't show them.

See [docs/AUDIOMUSE-AI.md](docs/AUDIOMUSE-AI.md) for setup notes and behavior.

### Standalone analyzers (local-files path only)

The repository also contains two Python analyzer services under `services/`:

- **`audio-analyzer`** — Essentia and MusiCNN for BPM, key, energy, and mood
- **`audio-analyzer-clap`** — LAION CLAP embeddings for similarity search, stored in pgvector

These read audio files directly from disk and are **not included in the all-in-one image**. They exist for the local-files development path and run via `docker-compose.dev.yml` or your own compose file. They benefit from an NVIDIA GPU via the NVIDIA Container Toolkit; passing `--gpus` to the Lidifin container itself has no effect, since it performs no analysis.

### Vibe API endpoints

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/vibe/similar/:trackId` | GET | Tracks similar to a given track |
| `/api/vibe/search` | POST | Search tracks by text description |
| `/api/vibe/status` | GET | Analysis and embedding progress |

---

## Integrations

Configure all of these in **Settings**. Credentials are encrypted before being stored.

### Lidarr

Request and download albums you don't own, and let Discover Weekly acquire new music automatically.

1. **Settings → Lidarr**
2. Enter your Lidarr URL (for example `http://localhost:8686`) and API key from Lidarr's **Settings → General**
3. Test the connection and save

Lidifin registers a webhook in Lidarr so it learns when imports finish. That requires Lidarr to reach Lidifin, which is what `LIDIFY_CALLBACK_URL` controls. The default `host.docker.internal:31013` works on most setups thanks to the `extra_hosts` entry in the compose file. On custom Docker networks with static IPs, set it explicitly:

```yaml
environment:
    - LIDIFY_CALLBACK_URL=http://YOUR_LIDIFIN_IP:31013
```

For extra safety, set a webhook secret in **Settings → Lidarr**. Signature verification is required on the webhook endpoint.

### Soulseek

Built-in Soulseek client for rare tracks and one-offs that Lidarr can't find. No slskd or other helper is needed.

1. Create an account at [slsknet.org](https://www.slsknet.org/) if you don't have one
2. **Settings → Soulseek** — enter your username and password

Soulseek results appear alongside Last.fm and Deezer results in search. Lidifin prefers FLAC and higher bitrates, parses metadata from the file path, downloads into your music folder, and retries with alternative users when a transfer fails or stalls. Artist pages also offer single-track downloads for popular tracks you don't own.

Set Soulseek as your primary or fallback download source in **Settings → Downloads**. Coverage varies by genre and popularity, and transfer speed depends on the remote user.

### Audiobookshelf

**Settings → Audiobookshelf** — enter your server URL and an API token from **Settings → Users → your user → API Token**. Progress syncs both ways.

### Metadata and discovery sources

Lidifin also draws on Last.fm, MusicBrainz, Deezer, Spotify, YouTube Music, iTunes, Podcast Index, Fanart.tv, and Wikidata for metadata, artwork, previews, and recommendations. Last.fm ships with a default application key; you can supply your own in Settings. An OpenAI key is optional and only used for AI-assisted features.

---

## Using Lidifin

### First run

1. **Create your account** — the first user becomes administrator
2. **Connect Jellyfin** — URL and API key, with a connection test
3. **Optionally connect** Lidarr, Soulseek, Audiobookshelf, and AudioMuse
4. **Start listening** — your Jellyfin library is available immediately; metadata enrichment continues in the background

### Home

Continue Listening, Recently Added, Library Radio, Made For You mixes, Recommended For You, podcasts, and audiobooks.

### Search

**Library search** covers what you own. **Discovery search** finds music and podcasts you don't, and separates exact text matches from musically similar artists. From discovery results you can preview via Deezer, request a download, or subscribe to a podcast.

<p align="center">
  <img src="assets/screenshots/desktop-artist.png" alt="Artist Page" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/desktop-album.png" alt="Album Page" width="800">
</p>

### Discover

The Discover page shows this week's playlist, generation status, and additional discovery shelves. Under the settings gear you can set playlist size, the ratio of new music to download, exclusions, and whether to acquire **full albums** or **individual songs**.

### Playlists

Create playlists from the Playlists page, add tracks from any track menu, drag to reorder, and toggle public visibility to share with other users on your instance. Changes sync to Jellyfin.

### Vibe and mood

Start any track, then hit the vibe button in the player to queue similar music. The Mood Mixer and Song Alchemy pages offer more deliberate ways to build a mix. Vibe mode disables shuffle while active.

### Playback settings

**Settings → Playback** controls stream quality (Original, 320, 192, or 128 kbps) and **Settings → Cache** limits how much disk transcoded files may use.

<p align="center">
  <img src="assets/screenshots/desktop-player.png" alt="Now Playing" width="800">
</p>
<p align="center">
  <img src="assets/screenshots/desktop-settings.png" alt="Settings" width="800">
</p>

### Keyboard shortcuts

Active during playback on desktop, and ignored while typing in a text field.

| Key | Action |
| --- | --- |
| Space | Play / pause |
| N | Next track |
| P | Previous track |
| S | Toggle shuffle |
| M | Toggle mute |
| ↑ / ↓ | Volume up / down 10% |
| → / ← | Seek forward / back 10 seconds |

Shortcuts are disabled on Android TV in favor of the remote's media keys.

### Installing as an app

**Android:** open Lidifin in Chrome, tap the menu, choose *Install app*.
**iOS:** open in Safari, tap Share, choose *Add to Home Screen*.

You get background audio, lock screen and notification controls, a full-screen player with sleep timer and playback speed, and offline caching of the app shell.

### Android TV

The TV interface activates automatically on Android TV and Fire TV devices, or with `?tv=1` in the URL. It offers large artwork, D-pad navigation, and a persistent Now Playing bar.

---

## Administration

### Users

**Settings → User Management** — create and delete accounts and assign the `admin` or `user` role. You cannot delete your own account.

### Downloads

**Settings → Downloads** — choose Soulseek or Lidarr as the primary source, configure fallback behavior, set concurrency and retry limits, and clear stuck discovery batches or downloads.

### Enrichment and analysis

**Settings → Cache & Automation** — tune enrichment concurrency, enable failure notifications, and retry or skip failed items. Circuit breakers stop runaway queues when an analyzer is unavailable, and failures collect in Enrichment Failures for review.

### Activity Panel

The bell icon in the top bar opens notifications, active downloads with per-track progress, and history. Soulseek jobs show the search query and result count.

### API keys and the mobile API

**Settings → API Keys** generates keys for programmatic access. Send them as `Authorization: Bearer YOUR_API_KEY`. Keys are SHA-256 hashed at rest and shown only once at creation.

Interactive docs live at `/api/docs`, and a dedicated mobile surface at `/api/docs/mobile`. Both require authentication in production unless `DOCS_PUBLIC=true`. See [docs/mobile-api-v1.md](docs/mobile-api-v1.md) for the full mobile reference.

### Job queues

**Bull Board** at `/api/admin/queues` shows active, waiting, completed, and failed background jobs and lets you retry or remove them. Admin authentication required.

### Security notes

- Access tokens expire after 24 hours; refresh tokens after 30 days. Changing a password invalidates every existing session.
- Stored integration credentials are AES-256-GCM encrypted with `SETTINGS_ENCRYPTION_KEY`.
- Outbound requests to user-supplied URLs go through an SSRF-guarded fetch that rejects private address ranges and re-validates redirects.
- Rate limits apply to authentication, image, and download endpoints.
- Lidifin is built for self-hosted use. For internet exposure, put it behind a reverse proxy with HTTPS and set `ALLOWED_ORIGINS`.
- Never commit your `.env`. If you route Soulseek through WireGuard, config files in `backend/mullvad/` are gitignored.

### Stability and timeouts

Long uptimes used to produce `socket hang up` errors. Several mechanisms now guard against that:

- **Request timeout** — handlers are capped at 90 seconds (`REQUEST_TIMEOUT_MS`); library list endpoints use a stricter 15 seconds
- **Keep-alive** — connections are held for five minutes so the frontend proxy doesn't reuse a socket the backend already closed
- **Event loop monitor** — logs a warning above 2 seconds of delay, reports `/health` as degraded at 10 seconds, and deliberately exits so Docker restarts the container on a severe stall
- **Health endpoint** — `/api/health` returns 503 when Postgres, Redis, or the event loop is unhealthy, which drives the container healthcheck
- **Database guards** — `DATABASE_STATEMENT_TIMEOUT_SEC` cancels runaway queries and returns connections to the pool

---

## Architecture

```
                        ┌──────────────────────┐
                        │   Browser / PWA / TV │
                        └───────────┬──────────┘
                                    │  :31013
        ┌───────────────────────────▼───────────────────────────┐
        │        Lidifin container (jamzercise/lidifin)         │
        │                                                       │
        │   Frontend  Next.js  :3030   ── proxies /api/* ──┐    │
        │                                                  │    │
        │   Backend   Express  :3006 (loopback) ◄──────────┘    │
        │   Worker    BullMQ + enrichment + cron                │
        │                                                       │
        │   PostgreSQL :5432 (loopback)   Redis :6379 (loopback)│
        │                                                       │
        │   Volumes: /data   /music (optional)                  │
        └───────┬───────────────────┬───────────────────┬───────┘
                │                   │                   │
      ┌─────────▼───────┐  ┌────────▼────────┐  ┌───────▼────────┐
      │    Jellyfin     │  │  Lidarr /       │  │ Audiobookshelf │
      │ library +       │  │  Soulseek       │  │   (optional)   │
      │ streaming       │  │  (acquisition)  │  └────────────────┘
      │ + AudioMuse AI  │  └─────────────────┘
      └─────────────────┘
```

**Processes.** The backend API and the background worker are separate Node processes supervised inside the container. The API serves requests and enqueues jobs; the worker runs BullMQ queues (library scan, Discover Weekly, image optimization, file validation), the unified enrichment loop, the Sunday Discover cron, download reconciliation, and Jellyfin metadata maintenance.

**Downloads.** The `DownloadJob` table in PostgreSQL is the single source of truth for download state. Requests create a row, an acquisition service routes it to Lidarr or Soulseek based on your settings, and completion arrives either via Lidarr webhook or in-process for Soulseek. Jobs still `processing` after 30 minutes are reconciled at startup.

**Playback.** The frontend runs one Howler-based audio engine. A playback state machine with explicit valid transitions is the single source of truth for playback status, and React state is derived from it rather than tracked separately.

**Decisions.** Architecture Decision Records live in [`adr/`](adr/README.md) and cover the Jellyfin-authoritative library, analysis storage, Prisma's role, artist detail loading, Postgres observability defaults, accessibility patterns, and track-first discovery.

---

## Development

Lidifin is two independent npm packages, `backend/` and `frontend/`. There is no workspace root.

```bash
# 1. Start Postgres (host port 5433) and Redis (6380)
docker compose -f docker-compose.dev.yml up -d

# 2. Configure the backend
cp .env.example backend/.env    # then set SETTINGS_ENCRYPTION_KEY and SESSION_SECRET

# 3. Backend
cd backend
npm install
npx prisma migrate deploy
npm run dev          # API on :3006
npm run worker       # background worker, separate terminal

# 4. Frontend
cd frontend
npm install
npm run dev          # UI on :3030
```

Useful commands:

| Command | Location | Purpose |
| --- | --- | --- |
| `npm run build` | backend | `tsc` + path alias rewrite |
| `npm test` | backend | Jest unit tests |
| `npm run db:migrate` | backend | Apply Prisma migrations |
| `npm run lint` | frontend | ESLint, including `jsx-a11y` rules |
| `npx tsc --noEmit` | frontend | Type check |
| `npm run test:e2e` | frontend | Playwright end-to-end suite |

Pull requests run backend typecheck, backend tests, frontend lint, frontend typecheck, and a Docker build. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

Database migrations are applied automatically when the container starts, including baselining for databases created before Prisma migrations were introduced.

---

## Troubleshooting

Start with [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md), which covers artist URLs, favorites, playlists, and genre radio.

**Playback fails but the library loads.** Your client can't reach Jellyfin. The Jellyfin URL in Settings must be reachable from the browser or device, not just from the container.

**Vibe and mood features are missing.** No analysis data yet. Confirm the AudioMuse AI plugin is installed in Jellyfin, has finished analyzing, and is configured in **Settings → AudioMuse**.

**Downloads fail with `Cannot create destination directory: EACCES`.** The folder mounted at `/music` isn't writable by the user the app runs as. Run `ls -ldn` on the host path and set `PUID`/`PGID` to the owner shown — see [Download permissions](#download-permissions).

**Lidarr never reports completion.** Lidarr can't reach Lidifin's webhook. Verify `LIDIFY_CALLBACK_URL` is an address Lidarr can resolve, and check Lidarr's logs for connection errors.

**Container won't start with a permission error.** If you bind-mounted `/data`, create `postgres` and `redis` subdirectories and `chown` them to the UID shown in the startup log.

**UI hangs, logs show `socket hang up`.** The frontend proxy lost its connection to the backend. Check for `[EventLoop] Delay detected` or `[RequestTimeout]` in the logs just before it. Restarting clears it; if it recurs, raise the container memory limit.

```bash
docker compose restart
docker compose logs -f lidifin
```

---

## Documentation

| Document | Contents |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | Docker and Dockge installation |
| [docs/JELLYFIN.md](docs/JELLYFIN.md) | Jellyfin integration internals |
| [docs/AUDIOMUSE-AI.md](docs/AUDIOMUSE-AI.md) | AudioMuse AI setup and behavior |
| [docs/mobile-api-v1.md](docs/mobile-api-v1.md) | Mobile API reference |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Performance and caching notes |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common problems |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Planned work |
| [docs/CHROMECAST_ANDROID_AUTO.md](docs/CHROMECAST_ANDROID_AUTO.md) | Cast and Android Auto plans |
| [adr/README.md](adr/README.md) | Architecture Decision Records |

---

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md). Current themes include a native mobile app, offline playback, deeper Soulseek and playlist-import visibility, and Android Auto support.

---

## License

Lidifin is released under the [GNU General Public License v3.0](LICENSE), inherited from Lidify. You may use, modify, and distribute it under those terms.

---

## Acknowledgments

Lidifin stands on:

- [Jellyfin](https://jellyfin.org/) — the media server that holds the library
- [Lidify](https://github.com/Chevron7Locked/lidify) — the upstream project Lidifin forked from
- [AudioMuse AI](https://github.com/NeptuneHub/AudioMuse-AI) — Jellyfin audio analysis
- [Lidarr](https://lidarr.audio/) — music collection management
- [Audiobookshelf](https://www.audiobookshelf.org/) — audiobook and podcast server
- [Last.fm](https://www.last.fm/) and [MusicBrainz](https://musicbrainz.org/) — metadata and recommendations
- [Deezer](https://developers.deezer.com/) — previews and featured playlists
- [Fanart.tv](https://fanart.tv/) — artwork
- [iTunes Search API](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/) and [Podcast Index](https://podcastindex.org/) — podcast discovery
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — YouTube Music import

---

## Support

1. Check [Issues](https://github.com/jamzercise/lidifin/issues) for known problems
2. Open a new issue describing your setup and what went wrong
3. Include relevant output from `docker compose logs lidifin`

---

_Built for the self-hosted community._
