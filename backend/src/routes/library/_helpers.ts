import { Response } from "express";
import { logger } from "../../utils/logger";

export { logger };

export const JELLYFIN_UNREACHABLE_MESSAGE =
    "Jellyfin is slow or unreachable. Check your Jellyfin instance.";

export const JELLYFIN_UUID_REGEX = /^[a-f0-9]{32}$/i;
export const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveIdForJellyfin(idParam: string): string {
    if (idParam.startsWith("jellyfin:")) return idParam;
    if (JELLYFIN_UUID_REGEX.test(idParam)) return `jellyfin:${idParam}`;
    return idParam;
}

export const ARTIST_SORT_MAP: Record<string, any> = {
    "name": { name: "asc" as const },
    "name-desc": { name: "desc" as const },
    // Arch-X.d removed `Artist.totalTrackCount`. The "tracks" sort
    // option falls back to alphabetical until a Jellyfin-derived count
    // sort lands in a follow-up.
    "tracks": { name: "asc" as const },
};

export const ALBUM_SORT_MAP: Record<string, any> = {
    "name": { title: "asc" as const },
    "name-desc": { title: "desc" as const },
    "recent": { year: "desc" as const },
};

export const TRACK_SORT_MAP: Record<string, any> = {
    "name": { title: "asc" as const },
    "name-desc": { title: "desc" as const },
};

export const MAX_LIMIT = 10000;

export const applyCoverArtCorsHeaders = (res: Response, origin?: string) => {
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
    } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
};

// Re-exported from utils/safeFetch so existing imports keep working.
// safeFetch also provides safeFetchRemote for URLs derived from
// user-controllable data (SSRF validation + size caps).
export { fetchWithRetry } from "../../utils/safeFetch";
