/**
 * Route ID utilities for artist/album URLs.
 * - Artists: use MusicBrainz ID when available, else artist name (for Jellyfin/native).
 * - Albums: use MusicBrainz rgMbid when available, else Jellyfin UUID or native ID.
 */

const JELLYFIN_PREFIX = "jellyfin:";
const ARTICLE_MAP: Record<string, string> = {
    the: "The",
    a: "A",
    an: "An",
};

function canonicalizeArtistArticleOrder(name: string): string {
    const trimmed = (name ?? "").trim();
    if (!trimmed) return "";
    const trailingArticleMatch = trimmed.match(/^(.+),\s*(the|a|an)$/i);
    if (!trailingArticleMatch) return trimmed;
    const base = trailingArticleMatch[1].trim();
    const article =
        ARTICLE_MAP[trailingArticleMatch[2].toLowerCase()] ??
        trailingArticleMatch[2];
    if (!base) return trimmed;
    return `${article} ${base}`;
}

/**
 * Convert an internal ID to a URL-safe route ID (strips jellyfin: prefix).
 */
export function toRouteId(id: string | undefined | null): string {
    if (!id) return "";
    if (id.startsWith(JELLYFIN_PREFIX)) {
        return id.slice(JELLYFIN_PREFIX.length);
    }
    return id;
}

/**
 * Get the artist route ID for links.
 * Always prefers artist name when available so URLs are /artist/ArtistName.
 * This ensures all artist pages resolve correctly (library + discovery) and
 * avoids blank pages when mbid URLs fail to resolve in Jellyfin-only mode.
 * Falls back to mbid or id only when name is unavailable.
 */
export function toArtistRouteId(artist: {
    mbid?: string | null;
    id?: string;
    name?: string;
}): string {
    const name = artist.name?.trim();
    if (name) return canonicalizeArtistArticleOrder(name);
    if (artist.mbid) return artist.mbid;
    return artist.id ?? "";
}

/**
 * Get the album route ID for links.
 * Prefers MusicBrainz rgMbid when available (for /album/{mbid} URLs).
 * Falls back to id (Jellyfin UUID or native) when no rgMbid.
 */
export function toAlbumRouteId(album: string | { id?: string; rgMbid?: string | null }): string {
    const id = typeof album === "string" ? album : album.id;
    const rgMbid = typeof album === "string" ? undefined : album.rgMbid;
    if (rgMbid) return rgMbid;
    return toRouteId(id ?? "");
}
