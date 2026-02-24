/**
 * Route ID utilities for artist/album URLs.
 * - Artists: use MusicBrainz ID when available, else artist name (for Jellyfin/native).
 * - Albums: use MusicBrainz rgMbid when available, else Jellyfin UUID or native ID.
 */

const JELLYFIN_PREFIX = "jellyfin:";

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
 * - Prefers MusicBrainz mbid when available (discovery/enriched).
 * - For Jellyfin artists (no mbid): use artist name so URL is /artist/Lucero.
 * - For native library: use id (cuid) as fallback.
 */
export function toArtistRouteId(artist: {
    mbid?: string | null;
    id?: string;
    name?: string;
}): string {
    if (artist.mbid) return artist.mbid;
    const name = artist.name?.trim();
    if (artist.id?.startsWith(JELLYFIN_PREFIX) && name) {
        return name;
    }
    return artist.id ?? "";
}

/**
 * Get the album route ID for links.
 * Prefers MusicBrainz rgMbid when available (for /album/{mbid} URLs).
 * Falls back to id (Jellyfin UUID or native) when no rgMbid.
 */
export function toAlbumRouteId(album: string | { id: string; rgMbid?: string | null }): string {
    const id = typeof album === "string" ? album : album.id;
    const rgMbid = typeof album === "string" ? undefined : album.rgMbid;
    if (rgMbid) return rgMbid;
    return toRouteId(id);
}
