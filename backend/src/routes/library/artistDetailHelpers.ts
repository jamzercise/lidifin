/**
 * Pure helpers for the Jellyfin-first artist-detail handler.
 *
 * Kept out of the route file so they can be unit-tested in isolation — the
 * route itself wires these together with Express, Prisma, Redis, Jellyfin and
 * Last.fm calls, which are integration concerns. The contracts here are the
 * stable surface; the route is just glue.
 */

import type { ResolvedAlbum, ResolvedTrack } from "../../services/jellyfin";

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
                duration: Math.floor(toInt(lfm.duration) / 1000),
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
    return jfTracks.slice(0, limit).map((t) => ({
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
