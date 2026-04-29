/**
 * Pure helpers for the Jellyfin-first artist-detail handler.
 *
 * Kept out of the route file so they can be unit-tested in isolation — the
 * route itself wires these together with Express, Prisma, Redis, Jellyfin and
 * Last.fm calls, which are integration concerns. The contracts here are the
 * stable surface; the route is just glue.
 */

import type {
    JellyfinConfig,
    ResolvedAlbum,
    ResolvedArtist,
    ResolvedTrack,
} from "../../services/jellyfin";
import { normalizeArtistName } from "../../utils/artistNormalization";

/**
 * Album shape returned to the frontend by the artist-detail endpoint.
 * Matches the existing wire format consumed by `frontend/features/artist`.
 */
export interface ArtistDetailAlbum {
    id: string;
    rgMbid: string | null;
    title: string;
    year: number | null;
    coverArt: string | null;
    coverUrl: string | null;
    artist: { id: string; name: string };
    artistId: string;
    owned: boolean;
    source: "jellyfin";
    type: string | null;
    tracks: never[];
}

/**
 * Track shape returned to the frontend by the artist-detail endpoint.
 * Owned tracks have a populated `album.id` (Jellyfin UUID); preview-only
 * tracks (Last.fm matches with no library counterpart) omit it, which the
 * frontend uses to render the "PREVIEW" badge.
 */
export interface ArtistDetailTopTrack {
    id: string;
    title: string;
    duration: number;
    playCount: number;
    listeners: number;
    userPlayCount: number;
    url?: string;
    artist?: { id: string; name: string };
    album: {
        id?: string;
        title: string;
        coverArt: string | null;
    };
}

/**
 * Minimal Last.fm top-track shape we depend on. Last.fm returns numeric
 * fields as strings, so callers should pass through whatever the API
 * yields and let this module coerce.
 */
export interface LastfmTopTrack {
    name: string;
    playcount?: string | number;
    listeners?: string | number;
    duration?: string | number;
    url?: string;
    album?: { "#text"?: string };
}

export function normalizeAlbumTitle(value: string | null | undefined): string {
    return (value ?? "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function toInt(value: string | number | undefined, fallback = 0): number {
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    if (typeof value !== "string") return fallback;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Last.fm `artist.getTopTracks` documents duration in **seconds**, but some
 * cached/pipelined payloads still carry **milliseconds** (e.g. 180000).
 * Values ≥ 36_000 are implausible as seconds for a single charting track, so
 * we treat them as ms. This fixes Popular showing `0:00` for normal songs
 * (e.g. 195s misread as 195ms via `floor(n/1000)`).
 */
export function lastfmDurationToSeconds(
    raw: string | number | undefined
): number {
    const n = toInt(raw, 0);
    if (n <= 0) return 0;
    if (n >= 36_000) return Math.floor(n / 1000);
    return n;
}

/**
 * Transform Jellyfin albums (the authoritative owned set) into the wire
 * shape consumed by the frontend. Every entry is `owned: true` and uses a
 * `jellyfin:UUID` id, eliminating the MBID-leak class of bugs that the
 * pre-refactor handler had to fight.
 */
export function transformJellyfinAlbums(
    jfAlbums: ResolvedAlbum[],
    artistFallback: { id: string; name: string }
): ArtistDetailAlbum[] {
    return jfAlbums
        .map((a) => {
            const artist = a.artist ?? artistFallback;
            return {
                id: a.id,
                rgMbid: a.rgMbid ?? null,
                title: a.title,
                year: a.year ?? null,
                coverArt: a.coverArt,
                coverUrl: a.coverArt,
                artist,
                artistId: artist.id,
                owned: true as const,
                source: "jellyfin" as const,
                type: null,
                tracks: [] as never[],
            };
        })
        .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
}

/**
 * Match Last.fm top tracks against the artist's actual Jellyfin tracks.
 *
 * Tracks that match a Jellyfin title come back with the real `jellyfin:UUID`
 * and an `album.id`, so the frontend renders them as playable. Unmatched
 * tracks are returned with a synthetic `lastfm-…` id and no `album.id`,
 * which the UI flags as "PREVIEW". This is the central fix for the
 * popular-songs PREVIEW-tag bug.
 *
 * The input list may exceed the desired output length; we cap to `limit`
 * after matching so the caller doesn't have to.
 */
export function matchTopTracks(
    lastfmTopTracks: LastfmTopTrack[],
    jfTracks: ResolvedTrack[],
    userPlayCounts: Map<string, number>,
    artistKey: string,
    options: { limit?: number } = {}
): ArtistDetailTopTrack[] {
    const limit = options.limit ?? 10;
    const tracksByTitle = new Map<string, ResolvedTrack>();
    for (const t of jfTracks) {
        // Jellyfin stubs (0s runtime) cause false Last.fm matches — e.g. artist-
        // name “tracks” or placeholder items — and bypass the PREVIEW path.
        if (t.duration <= 0) continue;
        const key = t.title.toLowerCase();
        if (!tracksByTitle.has(key)) tracksByTitle.set(key, t);
    }

    const out: ArtistDetailTopTrack[] = [];
    for (const lfm of lastfmTopTracks) {
        const key = lfm.name.toLowerCase();
        const matched = tracksByTitle.get(key);
        if (matched) {
            out.push({
                id: matched.id,
                title: matched.title,
                duration: matched.duration,
                playCount: toInt(lfm.playcount),
                listeners: toInt(lfm.listeners),
                userPlayCount: userPlayCounts.get(matched.id) ?? 0,
                url: lfm.url,
                artist: matched.artist,
                album: {
                    id: matched.album.id,
                    title: matched.album.title,
                    coverArt: matched.album.coverArt,
                },
            });
        } else {
            out.push({
                id: `lastfm-${artistKey}-${lfm.name}`,
                title: lfm.name,
                duration: lastfmDurationToSeconds(lfm.duration),
                playCount: toInt(lfm.playcount),
                listeners: toInt(lfm.listeners),
                userPlayCount: 0,
                url: lfm.url,
                album: {
                    title: lfm.album?.["#text"] || "Unknown Album",
                    coverArt: null,
                },
            });
        }
    }
    return out.slice(0, limit);
}

/**
 * Build the artist “Popular” list: Last.fm order, but only **playable** Jellyfin
 * rows. Drops Last.fm-only PREVIEW placeholders so the UI matches real library
 * tracks; pads with `topTracksFromJellyfin` when needed.
 */
export function popularTracksPreferLibrary(
    lastfmTopTracks: LastfmTopTrack[],
    jfTracks: ResolvedTrack[],
    userPlayCounts: Map<string, number>,
    artistKey: string,
    options: { lastfmLimit?: number; outputTarget?: number } = {}
): ArtistDetailTopTrack[] {
    const lastfmLimit = options.lastfmLimit ?? 20;
    const outputTarget = options.outputTarget ?? 10;
    const matched = matchTopTracks(
        lastfmTopTracks,
        jfTracks,
        userPlayCounts,
        artistKey,
        { limit: lastfmLimit }
    );
    const out: ArtistDetailTopTrack[] = [];
    for (const t of matched) {
        if (t.album?.id) out.push(t);
        if (out.length >= outputTarget) return out;
    }
    const playableJf = jfTracks.filter((t) => t.duration > 0);
    const seen = new Set(out.map((r) => r.id));
    const filler = topTracksFromJellyfin(playableJf, userPlayCounts, {
        limit: Math.max(outputTarget * 2, 20),
    });
    for (const t of filler) {
        if (seen.has(t.id)) continue;
        out.push(t);
        seen.add(t.id);
        if (out.length >= outputTarget) break;
    }
    return out.slice(0, outputTarget);
}

/**
 * Collect a Jellyfin artist's full owned album set, defending against
 * Jellyfin metadata splits.
 *
 * Real-world Jellyfin libraries can store the same artist as two separate
 * `MusicArtist` records (e.g., "Hold Steady" and "The Hold Steady" both
 * exist), or have individual album files tagged with an alias variant of
 * the artist name. In either case `getJellyfinAlbumsAllForArtist` against
 * a single primary artist id misses albums the user actually owns; the
 * frontend then renders them as available-to-download discovery, which is
 * exactly the bug X.a.1.1 fixes.
 *
 * Strategy:
 *   1. Fetch albums under the primary artist record (the authoritative
 *      relation when metadata is clean).
 *   2. Search Jellyfin for artist records by each name alias.
 *   3. For every sibling whose normalized name is in the alias set, union
 *      its albums into the result. Dedupe by Jellyfin album id.
 *
 * Dependencies are passed in so this function stays unit-testable without
 * spinning up Jellyfin or mocking module imports.
 */
export async function collectJellyfinAlbumsForArtistAliases(
    cfg: JellyfinConfig,
    primaryArtistId: string,
    aliases: string[],
    deps: {
        getAlbumsForArtist: (
            cfg: JellyfinConfig,
            artistId: string
        ) => Promise<ResolvedAlbum[]>;
        searchArtists: (
            cfg: JellyfinConfig,
            opts: { search: string; limit: number; offset: number }
        ) => Promise<{ artists: ResolvedArtist[]; total: number }>;
    }
): Promise<ResolvedAlbum[]> {
    const primary = await deps.getAlbumsForArtist(cfg, primaryArtistId);
    const seenAlbumIds = new Set<string>(primary.map((a) => a.id));
    const out: ResolvedAlbum[] = [...primary];

    if (aliases.length === 0) return out;

    const normalizedAliases = new Set(
        aliases.map((a) => normalizeArtistName(a)).filter(Boolean)
    );
    if (normalizedAliases.size === 0) return out;

    // Track which Jellyfin artist ids we've already pulled albums for so
    // duplicate alias searches don't re-fetch.
    const visitedArtistIds = new Set<string>([primaryArtistId]);

    for (const alias of aliases) {
        let searchResult: { artists: ResolvedArtist[]; total: number };
        try {
            searchResult = await deps.searchArtists(cfg, {
                search: alias,
                limit: 25,
                offset: 0,
            });
        } catch {
            continue;
        }

        for (const candidate of searchResult.artists) {
            if (visitedArtistIds.has(candidate.id)) continue;
            if (!normalizedAliases.has(normalizeArtistName(candidate.name))) {
                continue;
            }
            visitedArtistIds.add(candidate.id);

            try {
                const siblingAlbums = await deps.getAlbumsForArtist(
                    cfg,
                    candidate.id
                );
                for (const album of siblingAlbums) {
                    if (!seenAlbumIds.has(album.id)) {
                        seenAlbumIds.add(album.id);
                        out.push(album);
                    }
                }
            } catch {
                // Best-effort: a single sibling lookup failure shouldn't
                // collapse the rest of the recovery.
            }
        }
    }

    return out;
}

/**
 * Fall back to the artist's Jellyfin tracks when Last.fm is unavailable or
 * returns nothing. Preserves the same wire shape as `matchTopTracks` so the
 * frontend doesn't need to branch.
 */
export function topTracksFromJellyfin(
    jfTracks: ResolvedTrack[],
    userPlayCounts: Map<string, number>,
    options: { limit?: number } = {}
): ArtistDetailTopTrack[] {
    const limit = options.limit ?? 10;
    const playable = jfTracks.filter((t) => t.duration > 0);
    return playable.slice(0, limit).map((t) => ({
        id: t.id,
        title: t.title,
        duration: t.duration,
        playCount: 0,
        listeners: 0,
        userPlayCount: userPlayCounts.get(t.id) ?? 0,
        artist: t.artist,
        album: {
            id: t.album.id,
            title: t.album.title,
            coverArt: t.album.coverArt,
        },
    }));
}
