# ADR 0007 — Track-first Discover acquisition (Soulseek singles instead of full albums)

**Status:** Proposed (design spike — not yet implemented)

## Context

Discover Weekly today is **album-first** end to end:

1. The recommender (`DiscoverWeeklyService.findRecommendedAlbumsMultiStrategy`) turns seed artists → Last.fm *similar artists* → picks **albums** (tiered 30% high / 40% medium / 20% explore / 10% wildcard).
2. Each album is acquired **in full** via the behavior matrix in `acquisitionService.acquireAlbum` (Lidarr or Soulseek).
3. The playlist is then built by **picking one random track per album**:

   ```
   // discoverWeekly.ts
   // Group tracks by album ID and pick ONE random track per album
   ```

So we download ~10 tracks to keep **1**. The cost of that:

- **Wasted bandwidth/disk** — ~90% of what we download is discarded for the playlist.
- **Large failure surface** — if the right edition of the album isn't findable, the whole recommendation dies, even though the single song almost certainly exists on the network.
- **Slower** — the playlist can't materialise until full albums finish importing.

The data model reflects the album bias: `DiscoveryAlbum` (`rgMbid`, `tier`, `similarity`, `likedAt`) → `DiscoveryTrack`; `DiscoveryBatch` counts `totalAlbums/completedAlbums/failedAlbums`; `DownloadJob.targetMbid` is an album MBID.

### Why it was built album-first (preserve the rationale)

- **Lidarr is album/artist-shaped** — it monitors *artists* and grabs *releases*; it has no "just this song" primitive. With Lidarr as source, album is the only natural unit.
- **Clean metadata + library coherence** — album grabs carry MBID tagging, cover art, and artist→album→track structure. Loose Soulseek singles often have inconsistent filenames/tags/bitrate.
- **"Keep this album in my library"** lifecycle works precisely because the whole album was grabbed.

### Why track-first is attractive for the *playlist* use case

- **Soulseek is natively track-level** — `acquisitionService.acquireTracks()` and `soulseekService.searchAndDownload(artist, title, album)` already exist; the album wrapper fights Soulseek's grain.
- **Higher hit rate per rec** — only one file must exist, not a full album in the right edition.
- **Faster + ~1/10th the disk/bandwidth.**
- **Recommendations align better** — Last.fm already exposes `getSimilarTracks()` (`track.getSimilar`) and `getArtistTopTracks()` (`artist.getTopTracks`), which map naturally onto "a playlist of songs."
- **Shared foundation with E3 "Song radio"** — that feature is *also* seed-track → similar-tracks → acquire-missing. Track-level acquisition + match validation is the substrate both want.

## Decision (proposed)

Introduce an opt-in **track-first Discover mode** that is **Soulseek-primary**, while keeping today's album mode for Lidarr-primary users and for the "keep" upgrade path.

### 1. Recommendation — track granularity
Add `findRecommendedTracksMultiStrategy()` alongside the album version. Seeds:
- `lastFmService.getSimilarTracks(artist, track)` from the user's recent/top tracks (high/medium/explore tiers by Last.fm match), plus
- `lastFmService.getArtistTopTracks(similarArtist)` for breadth (explore/wildcard).
Reuse the existing tier distribution and dedup (`seenArtists`, exclusions) at the *recording* level.

### 2. Acquisition — reuse `acquireTracks`
Route track-mode recs through `acquisitionService.acquireTracks(requests, context)` (Soulseek batch). Extend it to create **one `DownloadJob` per track** (today it batches) so the existing per-item Discovery UI (status/cancel/retry from Initiative A) works unchanged.

### 3. Match validation (quality)
Album grabs ride Lidarr quality profiles; singles vary (wrong version, live cut, low bitrate). Add a validation step on top of Soulseek's existing match scoring:
- **duration check** vs Last.fm/MusicBrainz recording length (reject > ~±8s),
- prefer lossless/≥256kbps where multiple candidates exist,
- de-prioritise filenames hinting at "live"/"remix" unless the rec is that.

### 4. Library + tagging
Land singles under a dedicated `Discover/<Artist>/...` path (reuse the existing `Artist/Album/filename` sanitiser). Where a recording MBID resolves, embed MusicBrainz tags + cover art so they're not orphan files. **Dedup**: skip recs already present in the library.

### 5. "Keep" = on-demand full-album upgrade (decided)
Hearting a discovery single resolves its album (MusicBrainz recording → release-group) and triggers `acquireAlbum` for the full release, replacing the single. This is the *efficient* version of today's behavior — we only grab the whole album when the user actually signals they want it.

### 6. Data model
- Add `mode: "album" | "track"` to `DiscoveryBatch` (default `"album"`).
- Allow a track-mode "single" representation. Pragmatic option: keep `DiscoveryAlbum` as the grouping row but let it represent a single (album title = source album or "Single"), and add `recordingMbid` + per-track `similarity`/`tier` to `DiscoveryTrack`. Add a `keptAsAlbumId` link for the upgrade path.

### 7. Settings / rollout
New setting `discoverAcquisitionMode: "album" | "track"` (default `album` for back-compat; suggest `track` when Soulseek is primary). **Lidarr-primary forces album mode.** Ship behind the setting so we can A/B the playlist quality before making it default.

## Consequences

- **Pro:** dramatically less waste, higher per-rec success, faster playlists, and a reusable track-acquisition core for E3.
- **Con / new work:** a tagging/organization pass for loose tracks, match-validation logic, library dedup, and the keep→upgrade flow. These are the real cost — not the recommendation/acquisition wiring, which mostly exists.
- **Coexistence:** album mode stays for Lidarr-primary setups; the two modes share batch/job/UI plumbing.

## Alternatives considered

- **Status quo (album-first).** Cleanest library, but the waste/failure-surface problem the user flagged remains.
- **Album-first but smarter track pick** (pick the *recommended/top* track instead of random). Cheaper change, but still downloads the whole album.
- **Track-first with no tagging pass.** Fastest to build, worst library hygiene — rejected.

## Open questions

1. Where exactly should singles live, and do we ever fold a kept single's neighbours into the library?
2. How aggressive should match validation be before it starts rejecting *findable* songs?
3. Do we migrate existing album-mode batches, or only apply track mode to new generations?

## Related

- Initiative A (download reliability + Discovery) — the per-album status/cancel/retry UI this would reuse.
- Initiative E3 (Discover hub) — **Song radio** shares the track-level acquisition core proposed here.
- ADR 0003 — Prisma stores metadata, not a content mirror (informs the tagging/dedup approach).
