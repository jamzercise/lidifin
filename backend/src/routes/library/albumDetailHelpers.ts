/**
 * Pure helpers extracted from `routes/library/albums.ts` so the wire-shape
 * transform from a Jellyfin album item to the frontend `Album` payload is
 * unit-testable without spinning up Jellyfin.
 *
 * Naming intentionally mirrors `artistDetailHelpers.ts` from X.a.1 — both
 * files together capture the Jellyfin-first "transform once, return"
 * pattern that the route handlers now use instead of multi-stage Prisma
 * reconciliation.
 */

import {
    extractRgMbid,
    getJellyfinImageUrl,
    type JellyfinConfig,
    type ResolvedTrack,
} from "../../services/jellyfin";

export interface AlbumDetailArtist {
    id: string;
    name: string;
    mbid: string | null;
}

export interface AlbumDetailResponse {
    id: string;
    title: string;
    artist: AlbumDetailArtist;
    albumArtists: AlbumDetailArtist[];
    isCompilation: boolean;
    tracks: ResolvedTrack[];
    owned: boolean;
    coverArt: string;
    coverUrl: string;
    rgMbid?: string;
    year?: number;
    type?: string | null;
}

/** Minimal shape we consume from a Jellyfin `MusicAlbum` / `BoxSet` item. */
export interface JellyfinAlbumItemShape {
    Id: string;
    Name: string;
    Type: string;
    AlbumArtists?: Array<{ Id: string; Name: string }> | null;
    ImageTags?: { Primary?: string } | null;
    ProviderIds?: Record<string, string | null> | null;
    ProductionYear?: number | null;
}

const VARIOUS_ARTIST_NAMES = new Set([
    "various artists",
    "various artist",
    "various",
    "va",
]);

export function normalizeAlbumArtistName(value: string | null | undefined): string {
    return (value ?? "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function isVariousArtistsName(value: string): boolean {
    return VARIOUS_ARTIST_NAMES.has(value);
}

/**
 * Pull album-artist credits off a Jellyfin item and map to the route's
 * stable `{ id, name }` shape, prefixing ids with `jellyfin:` so they
 * remain disambiguated from Prisma cuids on the wire.
 *
 * Returns an empty array when the item has no usable credits — callers
 * decide whether to fall back to a sole-track-artist or the discovery
 * artist row.
 */
export function getAlbumArtistsFromJellyfinItem(
    item: JellyfinAlbumItemShape | null | undefined
): Array<{ id: string; name: string }> {
    return (item?.AlbumArtists ?? [])
        .filter(
            (a): a is { Id: string; Name: string } =>
                !!a && !!a.Id && !!a.Name
        )
        .map((a) => ({
            id: `jellyfin:${a.Id}`,
            name: a.Name,
        }));
}

/**
 * An album is a "compilation" when either:
 *   - any credit normalizes to a "various artists" alias, OR
 *   - more than one distinct normalized credit name is listed.
 *
 * Single-artist albums (or albums where the only credits are duplicate
 * spellings of the same name) report `false`.
 */
export function isCompilationAlbumFromArtists(
    albumArtists: Array<{ id: string; name: string }>
): boolean {
    const normalized = albumArtists
        .map((a) => normalizeAlbumArtistName(a.name))
        .filter(Boolean);
    if (normalized.length === 0) return false;
    if (normalized.some((n) => isVariousArtistsName(n))) return true;
    return new Set(normalized).size > 1;
}

/**
 * Build the `Album` wire-shape from a resolved Jellyfin item plus its
 * tracks. Pure: no DB, no network, no globals.
 *
 * `overrides.rgMbidFromUrl` is used when the URL the client requested
 * carried a release-group MBID that may not be present in the Jellyfin
 * provider tags (Jellyfin agents can vary). The URL-supplied value wins
 * only when nothing extracts from `ProviderIds`.
 */
export function albumWireShapeFromJellyfin(
    cfg: JellyfinConfig,
    item: JellyfinAlbumItemShape,
    tracks: ResolvedTrack[],
    overrides?: { rgMbidFromUrl?: string }
): AlbumDetailResponse {
    const albumArtists = getAlbumArtistsFromJellyfinItem(item);

    const fallbackArtist: AlbumDetailArtist = item.AlbumArtists?.[0]
        ? {
              id: `jellyfin:${item.AlbumArtists[0].Id}`,
              name: item.AlbumArtists[0].Name,
              mbid: null,
          }
        : { id: "", name: "Unknown Artist", mbid: null };

    const albumArtistsWithMbid: AlbumDetailArtist[] =
        albumArtists.length > 0
            ? albumArtists.map((a) => ({ ...a, mbid: null }))
            : [fallbackArtist];

    const rgMbidFromItem = extractRgMbid(item.ProviderIds ?? undefined);
    const rgMbid = rgMbidFromItem ?? overrides?.rgMbidFromUrl;

    const coverArt = getJellyfinImageUrl(
        cfg.url,
        item.Id,
        item.ImageTags?.Primary,
        cfg.apiKey,
        cfg.userId
    );

    return {
        id: `jellyfin:${item.Id}`,
        title: item.Name,
        artist: albumArtistsWithMbid[0] ?? fallbackArtist,
        albumArtists: albumArtistsWithMbid,
        isCompilation: isCompilationAlbumFromArtists(albumArtistsWithMbid),
        tracks,
        owned: true,
        coverArt,
        coverUrl: coverArt,
        ...(rgMbid ? { rgMbid } : {}),
        ...(item.ProductionYear ? { year: item.ProductionYear } : {}),
    };
}
