/**
 * Jellyfin API client and DTO mapping for Lidifin (Jellyfin as music library).
 * Maps Jellyfin items to the same shapes the frontend expects (artist, album, track).
 * Track ids are exposed as jellyfin:{jellyfinItemId}.
 */

import axios, { AxiosInstance } from "axios";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";

const JELLYFIN_PREFIX = "jellyfin:";

/** TTL for Jellyfin list caches (1 hour). */
const JF_CACHE_TTL = 60 * 60;

/** TTL for artist album count cache (6 hours – counts change rarely). */
const JF_ALBUM_COUNT_CACHE_TTL = 6 * 60 * 60;

export interface JellyfinConfig {
    enabled: boolean;
    url: string;
    apiKey: string;
    /** Required: Jellyfin User ID for user-scoped paths (Library, Favorites, etc.) */
    userId: string;
}

export interface ResolvedTrack {
    id: string;
    title: string;
    duration: number;
    artist: { id: string; name: string };
    album: { id: string; title: string; coverArt: string | null };
}

export interface ResolvedArtist {
    id: string;
    name: string;
    coverArt?: string;
    /** MusicBrainz artist ID when available from Jellyfin ProviderIds */
    mbid?: string;
}

export interface ResolvedAlbum {
    id: string;
    title: string;
    coverArt: string | null;
    artist?: { id: string; name: string };
    year?: number;
    /** MusicBrainz release group ID when available from Jellyfin ProviderIds */
    rgMbid?: string;
}

/** Jellyfin API item (minimal shape we use) */
interface JellyfinItem {
    Id: string;
    Name: string;
    Type: string;
    AlbumId?: string;
    AlbumArtist?: string;
    AlbumArtists?: { Id: string; Name: string }[];
    RunTimeTicks?: number;
    ImageTags?: { Primary?: string };
    ProductionYear?: number;
    ParentId?: string;
    ProviderIds?: Record<string, string | null>;
}

const MBID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract MusicBrainz release group ID from Jellyfin ProviderIds. Exported for use in routes. */
export function extractRgMbid(providerIds?: Record<string, string | null>): string | undefined {
    if (!providerIds) return undefined;
    const val =
        providerIds.MusicbrainzReleaseGroup ??
        providerIds.MusicBrainzReleaseGroup ??
        providerIds.MusicBrainzAlbum;
    return val && MBID_REGEX.test(val) ? val : undefined;
}

/** Extract MusicBrainz artist ID from Jellyfin ProviderIds. Exported for use in routes. */
export function extractArtistMbid(providerIds?: Record<string, string | null>): string | undefined {
    if (!providerIds) return undefined;
    const val =
        providerIds.MusicbrainzArtist ??
        providerIds.MusicBrainzArtist ??
        providerIds.MusicBrainz;
    return val && MBID_REGEX.test(val) ? val : undefined;
}

function runTimeTicksToSeconds(ticks: number | undefined): number {
    if (ticks == null) return 0;
    return Math.floor(ticks / 10_000_000);
}

/**
 * Get Jellyfin config from system settings. Returns null if not enabled or missing URL, API key, or User ID.
 * Auth is API key + User ID only (no username/password). Uses forceRefresh for latest settings.
 */
export async function getJellyfinConfig(): Promise<JellyfinConfig | null> {
    const settings = await getSystemSettings(true);
    if (!settings?.jellyfinEnabled || !settings?.jellyfinUrl?.trim()) return null;
    const apiKey = settings.jellyfinApiKey?.trim();
    const userId = settings.jellyfinUserId?.trim();
    if (!apiKey || !userId) return null;
    const url = settings.jellyfinUrl.replace(/\/$/, "");
    return {
        enabled: true,
        url,
        apiKey,
        userId,
    };
}

export async function isJellyfinMusicSource(): Promise<boolean> {
    const cfg = await getJellyfinConfig();
    return cfg != null;
}

/**
 * No-op for backward compatibility. Call when system settings (URL, API key, User ID) change.
 * Auth is API key + User ID only; no in-memory caches.
 */
export function clearJellyfinSessionCache(): void {
    logger.debug("[Jellyfin] Settings change noted (no caches to clear)");
}

/**
 * Build Jellyfin Authorization header per guide (jmshrv.com/posts/jellyfin-api).
 * Format: MediaBrowser Client="...", Device="...", DeviceId="...", Version="...", Token="..."
 * Also set X-Emby-Token (Jellyfin uses it as fallback if token not in Authorization).
 */
function jellyfinAuthHeaders(token: string): { Authorization: string; "X-Emby-Token"?: string } {
    const escaped = token.replace(/"/g, '\\"');
    return {
        Authorization: `MediaBrowser Client="Lidifin", Device="Server", DeviceId="lidifin-server", Version="1.0", Token="${escaped}"`,
        "X-Emby-Token": token,
    };
}

function createClient(baseUrl: string, token: string): AxiosInstance {
    const headers: Record<string, string> = {
        ...jellyfinAuthHeaders(token),
        "Content-Type": "application/json",
    };
    const client = axios.create({
        baseURL: baseUrl,
        timeout: 15000,
        headers,
    });
    client.interceptors.response.use(
        (r) => r,
        (err) => {
            if (err.response?.status === 400 && err.response?.data != null) {
                logger.warn("[Jellyfin] 400 response:", JSON.stringify(err.response.data));
            }
            return Promise.reject(err);
        }
    );
    return client;
}

/** Token is always the API key (User ID is required in config). */
function getEffectiveToken(cfg: JellyfinConfig): string {
    return cfg.apiKey;
}

/** User ID is always from config (required when Jellyfin is enabled). */
function getEffectiveUserId(cfg: JellyfinConfig): string {
    return cfg.userId.trim();
}

/**
 * Map Jellyfin Audio item to frontend track shape. Optionally pass album/artist if already loaded.
 */
function mapJellyfinItemToTrack(
    item: JellyfinItem,
    album?: ResolvedAlbum,
    artistName?: string,
    artistId?: string
): ResolvedTrack {
    const aid = artistId ?? item.AlbumArtists?.[0]?.Id ?? item.AlbumArtist ?? "unknown";
    const aname = artistName ?? item.AlbumArtists?.[0]?.Name ?? item.AlbumArtist ?? "Unknown Artist";
    return {
        id: `${JELLYFIN_PREFIX}${item.Id}`,
        title: item.Name,
        duration: runTimeTicksToSeconds(item.RunTimeTicks),
        artist: { id: aid.startsWith("jellyfin:") ? aid : `${JELLYFIN_PREFIX}${aid}`, name: aname },
        album: album ?? {
            id: item.AlbumId ? `${JELLYFIN_PREFIX}${item.AlbumId}` : "",
            title: "Unknown Album",
            coverArt: null,
        },
    };
}

/**
 * Get image URL for a Jellyfin item (cover art).
 * Per Jellyfin API: /Items/{itemId}/Images/{imageType} — no Users prefix for images.
 * See https://api.jellyfin.org (paths /Items/{itemId}/Images/{imageType}).
 */
export function getJellyfinImageUrl(
    baseUrl: string,
    itemId: string,
    tag?: string,
    apiKey?: string,
    _userId?: string
): string {
    const base = baseUrl.replace(/\/$/, "");
    const path = `/Items/${itemId}/Images/Primary`;
    const params = new URLSearchParams();
    if (tag) params.set("tag", tag);
    if (apiKey) params.set("api_key", apiKey);
    const qs = params.toString();
    return `${base}${path}${qs ? "?" + qs : ""}`;
}

/**
 * Fetch artists from Jellyfin (MusicArtist).
 * Returns { artists, total } where total is TotalRecordCount from the API.
 */
export async function getJellyfinArtists(
    cfg: JellyfinConfig,
    options?: { limit?: number; offset?: number; search?: string }
): Promise<{ artists: ResolvedArtist[]; total: number }> {
    const userId = getEffectiveUserId(cfg);
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const search = (options?.search ?? "").replace(/:/g, "_");
    const cacheKey = userId ? `jf:artists:${userId}:${limit}:${offset}:${search}` : null;

    if (cacheKey && redisClient.isReady) {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached) as { artists: ResolvedArtist[]; total: number };
            }
        } catch {
            /* ignore Redis errors, fall through to Jellyfin */
        }
    }

    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const params: Record<string, string | number | boolean> = {
        IncludeItemTypes: "MusicArtist",
        Recursive: "true",
        Limit: limit,
        StartIndex: offset,
        Fields: "Id,Name,ImageTags,ProviderIds",
        EnableTotalRecordCount: true,
    };
    if (options?.search) params.SearchTerm = options.search;
    const res = await client.get<{ Items: JellyfinItem[]; TotalRecordCount?: number }>(path, {
        params,
    });
    const items = res.data?.Items ?? [];
    const total = res.data?.TotalRecordCount ?? items.length;
    const artists = items.map((a) => {
        // Jellyfin uses PascalCase (Name); some configs may use camelCase (name)
        const rawName = (a as { Name?: string; name?: string }).Name ?? (a as { Name?: string; name?: string }).name ?? "";
        const name = (rawName && String(rawName).trim()) || "Unknown Artist";
        return {
        id: `${JELLYFIN_PREFIX}${a.Id}`,
        name,
        mbid: extractArtistMbid(a.ProviderIds),
        coverArt: a.ImageTags?.Primary
            ? getJellyfinImageUrl(
                  cfg.url,
                  a.Id,
                  a.ImageTags.Primary,
                  cfg.apiKey,
                  cfg.userId
              )
            : undefined,
    };
    });
    const result = { artists, total };
    if (cacheKey && redisClient.isReady) {
        try {
            await redisClient.setEx(cacheKey, JF_CACHE_TTL, JSON.stringify(result));
        } catch {
            /* ignore Redis errors */
        }
    }
    return result;
}

/**
 * Fetch albums from Jellyfin (MusicAlbum). Optional parentId for artist's albums.
 * Returns { albums, total } where total is TotalRecordCount from the API.
 */
export async function getJellyfinAlbums(
    cfg: JellyfinConfig,
    options?: {
        limit?: number;
        offset?: number;
        artistId?: string;
        search?: string;
        sortBy?: string;
        sortOrder?: string;
    }
): Promise<{ albums: ResolvedAlbum[]; total: number }> {
    const userId = getEffectiveUserId(cfg);
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;
    const artistKey = (options?.artistId ?? "").replace(/:/g, "_");
    const searchKey = (options?.search ?? "").replace(/:/g, "_");
    const sortKey = `${options?.sortBy ?? ""}:${options?.sortOrder ?? ""}`;
    const cacheKey = userId ? `jf:albums:${userId}:${limit}:${offset}:${artistKey}:${searchKey}:${sortKey}` : null;

    if (cacheKey && redisClient.isReady) {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached) as { albums: ResolvedAlbum[]; total: number };
            }
        } catch {
            /* ignore Redis errors, fall through to Jellyfin */
        }
    }

    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const params: Record<string, string | number | boolean> = {
        IncludeItemTypes: "MusicAlbum",
        Recursive: "true",
        Limit: limit,
        StartIndex: offset,
        Fields: "Id,Name,ProductionYear,AlbumArtists,ParentId,ImageTags,ProviderIds",
        EnableTotalRecordCount: true,
    };
    if (options?.artistId) {
        const rawId = options.artistId.startsWith(JELLYFIN_PREFIX)
            ? options.artistId.slice(JELLYFIN_PREFIX.length)
            : options.artistId;
        params.ParentId = rawId;
    }
    if (options?.search) params.SearchTerm = options.search;
    if (options?.sortBy) params.SortBy = options.sortBy;
    if (options?.sortOrder) params.SortOrder = options.sortOrder;
    const res = await client.get<{ Items: JellyfinItem[]; TotalRecordCount?: number }>(path, {
        params,
    });
    const items = res.data?.Items ?? [];
    const total = res.data?.TotalRecordCount ?? items.length;
    const albums = items.map((a) => ({
        id: `${JELLYFIN_PREFIX}${a.Id}`,
        title: a.Name,
        coverArt: getJellyfinImageUrl(cfg.url, a.Id, a.ImageTags?.Primary, cfg.apiKey, cfg.userId),
        artist: a.AlbumArtists?.[0]
            ? { id: `${JELLYFIN_PREFIX}${a.AlbumArtists[0].Id}`, name: a.AlbumArtists[0].Name }
            : undefined,
        year: a.ProductionYear ?? undefined,
        rgMbid: extractRgMbid(a.ProviderIds),
    }));
    const result = { albums, total };
    if (cacheKey && redisClient.isReady) {
        try {
            await redisClient.setEx(cacheKey, JF_CACHE_TTL, JSON.stringify(result));
        } catch {
            /* ignore Redis errors */
        }
    }
    return result;
}

const ALBUMS_PAGE_SIZE = 200;

/**
 * Get album count for a single Jellyfin artist (lightweight - Limit: 1, only needs TotalRecordCount).
 */
export async function getJellyfinArtistAlbumCount(
    cfg: JellyfinConfig,
    artistId: string
): Promise<number> {
    const userId = getEffectiveUserId(cfg);
    const artistKey = artistId.replace(/:/g, "_");
    const cacheKey = userId ? `jf:albumCount:${userId}:${artistKey}` : null;

    if (cacheKey && redisClient.isReady) {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached != null) return parseInt(cached, 10);
        } catch {
            /* ignore Redis errors, fall through to Jellyfin */
        }
    }

    const { total } = await getJellyfinAlbums(cfg, {
        artistId,
        limit: 1,
        offset: 0,
    });

    if (cacheKey && redisClient.isReady) {
        try {
            await redisClient.setEx(cacheKey, JF_ALBUM_COUNT_CACHE_TTL, String(total));
        } catch {
            /* ignore Redis errors */
        }
    }
    return total;
}

/**
 * Get album counts for multiple Jellyfin artists in parallel (concurrency-limited).
 * Returns Map<artistId, albumCount>.
 */
export async function getJellyfinArtistAlbumCounts(
    cfg: JellyfinConfig,
    artistIds: string[],
    concurrency = 10
): Promise<Map<string, number>> {
    const pLimit = (await import("p-limit")).default;
    const limit = pLimit(concurrency);
    const results = await Promise.all(
        artistIds.map((id) =>
            limit(async () => {
                try {
                    const count = await getJellyfinArtistAlbumCount(cfg, id);
                    return { id, count };
                } catch (err) {
                    logger.debug(`[Jellyfin] Album count failed for ${id}:`, err);
                    return { id, count: 0 };
                }
            })
        )
    );
    return new Map(results.map((r) => [r.id, r.count]));
}

/**
 * Find a Jellyfin album by MusicBrainz release group ID.
 * Searches through albums (paginated) until one with matching ProviderIds is found.
 * Returns null if not found within limit (avoids scanning huge libraries).
 */
export async function getJellyfinAlbumByRgMbid(
    cfg: JellyfinConfig,
    rgMbid: string
): Promise<JellyfinItem | null> {
    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const maxToSearch = 2000;
    let offset = 0;

    while (offset < maxToSearch) {
        const res = await client.get<{ Items: JellyfinItem[]; TotalRecordCount?: number }>(path, {
            params: {
                IncludeItemTypes: "MusicAlbum",
                Recursive: "true",
                Limit: 100,
                StartIndex: offset,
                Fields: "Id,Name,ProductionYear,AlbumArtists,ParentId,ImageTags,ProviderIds",
            },
        });
        const items = res.data?.Items ?? [];
        if (items.length === 0) break;

        for (const item of items) {
            const found = extractRgMbid(item.ProviderIds);
            if (found === rgMbid) return item;
        }
        offset += items.length;
    }
    return null;
}

/** Max albums to fetch per artist (avoids many Jellyfin calls for prolific artists). */
const MAX_ARTIST_ALBUMS = 50;

/**
 * Fetch albums for an artist, capped at MAX_ARTIST_ALBUMS.
 * Use when an artist may have more than 200 albums.
 */
export async function getJellyfinAlbumsAllForArtist(
    cfg: JellyfinConfig,
    artistId: string
): Promise<ResolvedAlbum[]> {
    const all: ResolvedAlbum[] = [];
    let offset = 0;
    let total = 0;
    let fetched: ResolvedAlbum[];
    do {
        const remain = MAX_ARTIST_ALBUMS - all.length;
        if (remain <= 0) break;
        const result = await getJellyfinAlbums(cfg, {
            artistId,
            limit: Math.min(ALBUMS_PAGE_SIZE, remain),
            offset,
        });
        fetched = result.albums;
        total = result.total;
        all.push(...fetched);
        offset += fetched.length;
    } while (all.length < total && fetched.length > 0 && all.length < MAX_ARTIST_ALBUMS);
    return all;
}

const TRACKS_PAGE_SIZE = 500;

/** Max tracks to fetch per album (avoids slow loads for large albums). */
const MAX_ALBUM_TRACKS = 100;

/**
 * Fetch tracks for an album, capped at MAX_ALBUM_TRACKS.
 * Use when an album may have more than 500 tracks.
 */
export async function getJellyfinTracksAllForAlbum(
    cfg: JellyfinConfig,
    albumId: string
): Promise<ResolvedTrack[]> {
    const all: ResolvedTrack[] = [];
    let offset = 0;
    let total = 0;
    let fetched: ResolvedTrack[];
    do {
        const remain = MAX_ALBUM_TRACKS - all.length;
        if (remain <= 0) break;
        const result = await getJellyfinTracks(cfg, {
            albumId,
            limit: Math.min(TRACKS_PAGE_SIZE, remain),
            offset,
        });
        fetched = result.tracks;
        total = result.total;
        all.push(...fetched);
        offset += fetched.length;
    } while (all.length < total && fetched.length > 0 && all.length < MAX_ALBUM_TRACKS);
    return all;
}

/**
 * Fetch tracks (Audio) from Jellyfin. Optional albumId or artistId to filter.
 * Returns { tracks, total } where total is TotalRecordCount from the API.
 */
export async function getJellyfinTracks(
    cfg: JellyfinConfig,
    options?: {
        limit?: number;
        offset?: number;
        albumId?: string;
        artistId?: string;
        search?: string;
        /** e.g. "Random" for shuffle, "DateCreated" for newest */
        sortBy?: string;
    }
): Promise<{ tracks: ResolvedTrack[]; total: number }> {
    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const params: Record<string, string | number | boolean> = {
        IncludeItemTypes: "Audio",
        Recursive: "true",
        Limit: options?.limit ?? 100,
        StartIndex: options?.offset ?? 0,
        Fields: "Id,Name,RunTimeTicks,AlbumId,AlbumArtist,AlbumArtists,ImageTags,ParentId",
        EnableTotalRecordCount: true,
    };
    if (options?.sortBy) params.SortBy = options.sortBy;
    if (options?.albumId) {
        const rawId = options.albumId.startsWith(JELLYFIN_PREFIX)
            ? options.albumId.slice(JELLYFIN_PREFIX.length)
            : options.albumId;
        params.ParentId = rawId;
    }
    if (options?.artistId) {
        const rawId = options.artistId.startsWith(JELLYFIN_PREFIX)
            ? options.artistId.slice(JELLYFIN_PREFIX.length)
            : options.artistId;
        params.AlbumArtistIds = rawId;
    }
    if (options?.search) params.SearchTerm = options.search;
    const res = await client.get<{ Items: JellyfinItem[]; TotalRecordCount?: number }>(path, {
        params,
    });
    const items = res.data?.Items ?? [];
    const total = res.data?.TotalRecordCount ?? items.length;
    const tracks: ResolvedTrack[] = [];
    for (const item of items) {
        let album: ResolvedAlbum | undefined;
        if (item.AlbumId) {
            try {
                const albumItem = await getJellyfinItem(cfg, item.AlbumId, "MusicAlbum");
                if (albumItem)
                    album = {
                        id: `${JELLYFIN_PREFIX}${albumItem.Id}`,
                        title: albumItem.Name,
                        coverArt: getJellyfinImageUrl(
                            cfg.url,
                            albumItem.Id,
                            albumItem.ImageTags?.Primary,
                            cfg.apiKey,
                            cfg.userId
                        ),
                    };
            } catch {
                // ignore
            }
        }
        const artistId = item.AlbumArtists?.[0]?.Id;
        const artistName = item.AlbumArtists?.[0]?.Name;
        tracks.push(
            mapJellyfinItemToTrack(item, album, artistName, artistId ? `${JELLYFIN_PREFIX}${artistId}` : undefined)
        );
    }
    return { tracks, total };
}

/**
 * Get a single item by id (raw Jellyfin id, no prefix).
 * Uses effective token (session or API key) and user-scoped path when available.
 */
/**
 * Get a Jellyfin MusicArtist by name. Uses GET /Artists/{name}.
 * Returns null if not found.
 */
export async function getJellyfinArtistByName(
    cfg: JellyfinConfig,
    artistName: string
): Promise<JellyfinItem | null> {
    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const encodedName = encodeURIComponent(artistName);
    const path = `/Artists/${encodedName}`;
    try {
        const res = await client.get<JellyfinItem>(path, {
            params: userId ? { userId } : undefined,
        });
        const item = res.data;
        if (!item || item.Type !== "MusicArtist") return null;
        return item;
    } catch (err: any) {
        if (err.response?.status === 404) return null;
        logger.warn("[Jellyfin] getArtistByName failed:", artistName, err.message);
        throw err;
    }
}

export async function getJellyfinItem(
    cfg: JellyfinConfig,
    itemId: string,
    _itemType?: "MusicAlbum" | "Audio"
): Promise<JellyfinItem | null> {
    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId
        ? `/Users/${userId}/Items/${itemId}`
        : `/Items/${itemId}`;
    try {
        const res = await client.get<JellyfinItem>(path);
        return res.data ?? null;
    } catch (err: any) {
        if (err.response?.status === 404) return null;
        logger.warn("[Jellyfin] getItem failed:", itemId, err.message);
        throw err;
    }
}

/**
 * Get cover art URLs for multiple Jellyfin artist IDs in one API call.
 * Returns Map<artistId, coverArtUrl>. Artist IDs should be jellyfin:uuid format.
 */
export async function getJellyfinArtistImagesBatch(
    cfg: JellyfinConfig,
    artistIds: string[]
): Promise<Map<string, string>> {
    const jellyfinIds = artistIds
        .filter((id) => id.startsWith(JELLYFIN_PREFIX))
        .map((id) => id.slice(JELLYFIN_PREFIX.length));
    if (jellyfinIds.length === 0) return new Map();

    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    try {
        const res = await client.get<{ Items: JellyfinItem[] }>(path, {
            params: {
                Ids: jellyfinIds.join(","),
                Fields: "Id,ImageTags",
            },
        });
        const items = res.data?.Items ?? [];
        const result = new Map<string, string>();
        for (const item of items) {
            if (item.ImageTags?.Primary) {
                const url = getJellyfinImageUrl(
                    cfg.url,
                    item.Id,
                    item.ImageTags.Primary,
                    cfg.apiKey,
                    cfg.userId
                );
                result.set(`${JELLYFIN_PREFIX}${item.Id}`, url);
            }
        }
        return result;
    } catch (err: any) {
        logger.debug("[Jellyfin] getArtistImagesBatch failed:", err?.message);
        return new Map();
    }
}

/**
 * Get stream URL for a Jellyfin audio item (redirect URL). Client will follow redirect to stream.
 */
export async function getJellyfinStreamUrl(
    cfg: JellyfinConfig,
    itemId: string
): Promise<string> {
    const base = cfg.url.replace(/\/$/, "");
    const token = getEffectiveToken(cfg);
    return `${base}/Audio/${itemId}/stream?api_key=${encodeURIComponent(token)}&Static=true`;
}

/**
 * Proxy a Jellyfin audio stream through the backend. Used when the client cannot reach Jellyfin directly
 * (e.g. remote access). Backend fetches from Jellyfin and pipes to the client.
 * Supports Range requests for seeking.
 */
export async function streamJellyfinAudio(
    cfg: JellyfinConfig,
    itemId: string,
    rangeHeader?: string
): Promise<{ stream: import("stream").Readable; headers: Record<string, string>; status: number }> {
    const streamUrl = await getJellyfinStreamUrl(cfg, itemId);
    const requestHeaders: Record<string, string> = {};
    if (rangeHeader) {
        requestHeaders["Range"] = rangeHeader;
    }
    const response = await axios.get(streamUrl, {
        responseType: "stream",
        timeout: 0,
        headers: requestHeaders,
        validateStatus: (status) => status >= 200 && status < 300,
    });
    const headers: Record<string, string> = {};
    const copyHeaders = ["content-type", "content-length", "accept-ranges", "content-range"];
    for (const name of copyHeaders) {
        const val = response.headers[name];
        if (val != null) headers[name] = String(val);
    }
    if (!headers["accept-ranges"]) headers["accept-ranges"] = "bytes";
    return {
        stream: response.data,
        headers,
        status: response.status,
    };
}

/**
 * Resolve a single track reference (cuid or jellyfin:xxx) to ResolvedTrack, or null.
 */
export async function resolveTrackReference(trackId: string): Promise<ResolvedTrack | null> {
    if (trackId.startsWith(JELLYFIN_PREFIX)) {
        const cfg = await getJellyfinConfig();
        if (!cfg) return null;
        const rawId = trackId.slice(JELLYFIN_PREFIX.length);
        const item = await getJellyfinItem(cfg, rawId, "Audio");
        if (!item || item.Type !== "Audio") return null;
        let album: ResolvedAlbum | undefined;
        if (item.AlbumId) {
            const albumItem = await getJellyfinItem(cfg, item.AlbumId, "MusicAlbum");
            if (albumItem)
                album = {
                    id: `${JELLYFIN_PREFIX}${albumItem.Id}`,
                    title: albumItem.Name,
                    coverArt: getJellyfinImageUrl(
                        cfg.url,
                        albumItem.Id,
                        albumItem.ImageTags?.Primary,
                        cfg.apiKey,
                        cfg.userId
                    ),
                };
        }
        return mapJellyfinItemToTrack(
            item,
            album,
            item.AlbumArtists?.[0]?.Name,
            item.AlbumArtists?.[0] ? `${JELLYFIN_PREFIX}${item.AlbumArtists[0].Id}` : undefined
        );
    }
    const track = await prisma.track.findUnique({
        where: { id: trackId },
        include: {
            album: {
                include: {
                    artist: { select: { id: true, name: true } },
                },
            },
        },
    });
    if (!track) return null;
    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        artist: {
            id: track.album?.artist?.id ?? "",
            name: track.album?.artist?.name ?? "Unknown Artist",
        },
        album: {
            id: track.album?.id ?? "",
            title: track.album?.title ?? "Unknown Album",
            coverArt: track.album?.coverUrl ?? null,
        },
    };
}

/**
 * Resolve multiple track references in one go. Preserves order; null for missing.
 */
export async function resolveTrackReferences(
    trackIds: string[]
): Promise<(ResolvedTrack | null)[]> {
    const jellyfinIds: string[] = [];
    const nativeIds: string[] = [];
    const jellyfinIndexes: number[] = [];
    const nativeIndexes: number[] = [];
    trackIds.forEach((id, i) => {
        if (id.startsWith(JELLYFIN_PREFIX)) {
            jellyfinIds.push(id.slice(JELLYFIN_PREFIX.length));
            jellyfinIndexes.push(i);
        } else {
            nativeIds.push(id);
            nativeIndexes.push(i);
        }
    });

    const result: (ResolvedTrack | null)[] = new Array(trackIds.length).fill(null);

    const cfg = await getJellyfinConfig();
    const BATCH_SIZE = 50; // Smaller batches to avoid URL length limits; Jellyfin may truncate long Ids
    if (cfg && jellyfinIds.length > 0) {
        try {
            const token = getEffectiveToken(cfg);
            const userId = getEffectiveUserId(cfg);
            const client = createClient(cfg.url, token);
            const path = userId ? `/Users/${userId}/Items` : "/Items";

            const batches: { batchIds: string[]; batchIndexes: number[] }[] = [];
            for (let batchStart = 0; batchStart < jellyfinIds.length; batchStart += BATCH_SIZE) {
                batches.push({
                    batchIds: jellyfinIds.slice(batchStart, batchStart + BATCH_SIZE),
                    batchIndexes: jellyfinIndexes.slice(batchStart, batchStart + BATCH_SIZE),
                });
            }

            const batchResults = await Promise.all(
                batches.map(async ({ batchIds, batchIndexes }) => {
                    const res = await client.get<{ Items: JellyfinItem[] }>(path, {
                        params: {
                            Ids: batchIds.join(","),
                            IncludeItemTypes: "Audio",
                            Fields: "Id,Name,RunTimeTicks,AlbumId,AlbumArtist,AlbumArtists,ImageTags,ParentId",
                        },
                    });
                    const items = (res.data?.Items ?? []) as JellyfinItem[];
                    const byId = new Map(items.map((i) => [i.Id, i]));
                    return { batchIds, batchIndexes, byId };
                })
            );

            for (const { batchIds, batchIndexes, byId } of batchResults) {
                for (let j = 0; j < batchIds.length; j++) {
                    const item = byId.get(batchIds[j]);
                    const idx = batchIndexes[j];
                    if (item && item.Type === "Audio") {
                        result[idx] = mapJellyfinItemToTrack(
                            item,
                            undefined,
                            item.AlbumArtists?.[0]?.Name,
                            item.AlbumArtists?.[0] ? `${JELLYFIN_PREFIX}${item.AlbumArtists[0].Id}` : undefined
                        );
                    }
                }
            }
            const nullIndices: number[] = [];
            for (let k = 0; k < jellyfinIds.length; k++) {
                if (result[jellyfinIndexes[k]] == null) nullIndices.push(k);
            }
            const nullCount = nullIndices.length;
            if (nullCount > 0) {
                logger.debug(`[Jellyfin] resolveTrackReferences: ${nullCount}/${jellyfinIds.length} items unresolved from batch, trying per-item fallback`);
                const pLimit = (await import("p-limit")).default;
                const limit = pLimit(8);
                await Promise.all(
                    nullIndices.map((k) =>
                        limit(async () => {
                            const idx = jellyfinIndexes[k];
                            if (result[idx] != null) return;
                            const rawId = jellyfinIds[k];
                            try {
                                const single = await resolveTrackReference(`${JELLYFIN_PREFIX}${rawId}`);
                                if (single) result[idx] = single;
                            } catch {
                                // ignore
                            }
                        })
                    )
                );
            }
        } catch (err: any) {
            logger.warn("[Jellyfin] batch get items failed:", err.message, "— falling back to per-item");
            const pLimit = (await import("p-limit")).default;
            const limit = pLimit(8);
            await Promise.all(
                jellyfinIndexes.map((_, k) =>
                    limit(async () => {
                        const idx = jellyfinIndexes[k];
                        const rawId = jellyfinIds[k];
                        try {
                            const single = await resolveTrackReference(`${JELLYFIN_PREFIX}${rawId}`);
                            if (single) result[idx] = single;
                        } catch {
                            // ignore
                        }
                    })
                )
            );
        }
    }

    if (nativeIds.length > 0) {
        const nativeTracks = await prisma.track.findMany({
            where: { id: { in: nativeIds } },
            include: {
                album: {
                    include: {
                        artist: { select: { id: true, name: true } },
                    },
                },
            },
        });
        type NativeTrack = (typeof nativeTracks)[number];
        const byId = new Map<string, NativeTrack>(nativeTracks.map((t: NativeTrack) => [t.id, t]));
        for (let n = 0; n < nativeIds.length; n++) {
            const track = byId.get(nativeIds[n]);
            const idx = nativeIndexes[n];
            if (track) {
                result[idx] = {
                    id: track.id,
                    title: track.title,
                    duration: track.duration,
                    artist: {
                        id: track.album?.artist?.id ?? "",
                        name: track.album?.artist?.name ?? "Unknown Artist",
                    },
                    album: {
                        id: track.album?.id ?? "",
                        title: track.album?.title ?? "Unknown Album",
                        coverArt: track.album?.coverUrl ?? null,
                    },
                };
            }
        }
    }

    return result;
}

// --- Playlists (Lidifin sync) ---

/** Jellyfin user list item (minimal). */
interface JellyfinUser {
    Id: string;
    Name?: string;
}

/** Jellyfin playlist summary from Items API */
export interface JellyfinPlaylistSummary {
    id: string;
    name: string;
}

/** Get Jellyfin user id for API requests (from config; User ID is required when Jellyfin is enabled). */
export function getJellyfinUserId(cfg: JellyfinConfig): string {
    return getEffectiveUserId(cfg);
}

/**
 * Fetch all playlists from Jellyfin for the configured user.
 * Uses /Users/{userId}/Items?IncludeItemTypes=Playlist.
 */
export async function getJellyfinPlaylists(
    cfg: JellyfinConfig
): Promise<JellyfinPlaylistSummary[]> {
    const userId = getJellyfinUserId(cfg);
    if (!userId) return [];
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    const playlists: JellyfinPlaylistSummary[] = [];
    let offset = 0;
    const limit = 100;

    try {
        while (true) {
            const res = await client.get<{
                Items?: { Id: string; Name?: string }[];
                TotalRecordCount?: number;
            }>(`/Users/${userId}/Items`, {
                params: {
                    IncludeItemTypes: "Playlist",
                    Recursive: "true",
                    Limit: limit,
                    StartIndex: offset,
                    Fields: "Id,Name",
                },
            });
            const items = res.data?.Items ?? [];
            for (const it of items) {
                playlists.push({
                    id: it.Id,
                    name: it.Name ?? "Untitled Playlist",
                });
            }
            if (items.length < limit) break;
            offset += items.length;
        }
    } catch (err: any) {
        logger.warn("[Jellyfin] getPlaylists failed:", err.message);
    }
    return playlists;
}

/**
 * Update a Jellyfin playlist's name. Returns true on success.
 */
export async function updateJellyfinPlaylistName(
    cfg: JellyfinConfig,
    playlistId: string,
    name: string
): Promise<boolean> {
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        await client.post(`/Playlists/${playlistId}`, { Name: name });
        return true;
    } catch (err: any) {
        logger.warn("[Jellyfin] updatePlaylistName failed:", playlistId, err.message);
        return false;
    }
}

/**
 * Delete a playlist from Jellyfin. Playlists are Items; use DELETE /Items/{id}.
 */
export async function deleteJellyfinPlaylist(
    cfg: JellyfinConfig,
    playlistId: string
): Promise<boolean> {
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        await client.delete(`/Items/${playlistId}`);
        return true;
    } catch (err: any) {
        logger.warn("[Jellyfin] deletePlaylist failed:", playlistId, err.message);
        return false;
    }
}

/**
 * Create a playlist in Jellyfin. Returns the Jellyfin playlist id or null on failure.
 * itemIds: raw Jellyfin item ids (no jellyfin: prefix).
 */
export async function createJellyfinPlaylist(
    cfg: JellyfinConfig,
    name: string,
    itemIds: string[] = []
): Promise<string | null> {
    const userId = getJellyfinUserId(cfg);
    if (!userId) return null;
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        const res = await client.post<{ Id: string }>("/Playlists", {
            Name: name,
            Ids: itemIds,
            UserId: userId,
            MediaType: "Audio",
        });
        return res.data?.Id ?? null;
    } catch (err: any) {
        logger.warn("[Jellyfin] createPlaylist failed:", name, err.message);
        return null;
    }
}

/**
 * Add items to a Jellyfin playlist. itemIds are raw Jellyfin ids.
 */
export async function addToJellyfinPlaylist(
    cfg: JellyfinConfig,
    playlistId: string,
    itemIds: string[]
): Promise<boolean> {
    if (itemIds.length === 0) return true;
    const userId = getJellyfinUserId(cfg);
    if (!userId) return false;
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        await client.post(`/Playlists/${playlistId}/Items`, null, {
            params: { Ids: itemIds.join(","), UserId: userId },
        });
        return true;
    } catch (err: any) {
        logger.warn("[Jellyfin] addToPlaylist failed:", playlistId, err.message);
        return false;
    }
}

/**
 * Remove items from a Jellyfin playlist by entry ids.
 * Get entry ids from GET /Playlists/{id}/Items response (each item has Id = entry id).
 */
export async function removeFromJellyfinPlaylist(
    cfg: JellyfinConfig,
    playlistId: string,
    entryIds: string[]
): Promise<boolean> {
    if (entryIds.length === 0) return true;
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        await client.delete(`/Playlists/${playlistId}/Items`, {
            data: { EntryIds: entryIds },
        });
        return true;
    } catch (err: any) {
        logger.warn("[Jellyfin] removeFromPlaylist failed:", playlistId, err.message);
        return false;
    }
}

/**
 * Get playlist items from Jellyfin with full track metadata (Option A).
 * Uses GET /Playlists/{id}/Items with Fields - single API call, no separate resolution.
 * Returns items in playlist order with ResolvedTrack for display.
 */
export async function getJellyfinPlaylistItemsWithMetadata(
    cfg: JellyfinConfig,
    playlistId: string
): Promise<{ entryId: string; itemId: string; track: ResolvedTrack }[]> {
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        const res = await client.get<{
            Items?: (JellyfinItem & { PlaylistItemId?: string })[];
        }>(`/Playlists/${playlistId}/Items`, {
            params: {
                UserId: getJellyfinUserId(cfg),
                Fields: "Id,Name,RunTimeTicks,AlbumId,AlbumArtist,AlbumArtists,ImageTags,ParentId",
            },
        });
        const items = (res.data?.Items ?? []) as (JellyfinItem & { PlaylistItemId?: string })[];
        const result: { entryId: string; itemId: string; track: ResolvedTrack }[] = [];
        for (const it of items) {
            if (it.Type !== "Audio") continue;
            const track = mapJellyfinItemToTrack(
                it,
                undefined,
                it.AlbumArtists?.[0]?.Name,
                it.AlbumArtists?.[0] ? `${JELLYFIN_PREFIX}${it.AlbumArtists[0].Id}` : undefined
            );
            const coverArt = it.ImageTags?.Primary
                ? getJellyfinImageUrl(cfg.url, it.Id, it.ImageTags.Primary, cfg.apiKey, cfg.userId)
                : null;
            if (coverArt) {
                track.album = { ...track.album, coverArt };
            }
            result.push({
                entryId: it.PlaylistItemId ?? it.Id,
                itemId: it.Id,
                track,
            });
        }
        return result;
    } catch (err: any) {
        logger.warn("[Jellyfin] getPlaylistItemsWithMetadata failed:", playlistId, err.message);
        return [];
    }
}

/**
 * Get playlist items from Jellyfin to obtain entry ids (for remove/reorder).
 * Returns array of { entryId, itemId } where itemId is the audio item id.
 */
export async function getJellyfinPlaylistItems(
    cfg: JellyfinConfig,
    playlistId: string
): Promise<{ entryId: string; itemId: string }[]> {
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        const res = await client.get<{ Items?: { Id: string; PlaylistItemId?: string }[] }>(
            `/Playlists/${playlistId}/Items`,
            { params: { UserId: getJellyfinUserId(cfg) } }
        );
        const items = res.data?.Items ?? [];
        return items.map((it) => ({
            entryId: it.PlaylistItemId ?? it.Id,
            itemId: it.Id,
        }));
    } catch (err: any) {
        logger.warn("[Jellyfin] getPlaylistItems failed:", playlistId, err.message);
        return [];
    }
}

/**
 * Replace all items in a Jellyfin playlist with the given order (raw Jellyfin item ids).
 * Clears existing items then adds new ones. Best-effort; returns true if add succeeded.
 */
export async function setJellyfinPlaylistItems(
    cfg: JellyfinConfig,
    playlistId: string,
    itemIds: string[]
): Promise<boolean> {
    const existing = await getJellyfinPlaylistItems(cfg, playlistId);
    const entryIds = existing.map((e) => e.entryId).filter(Boolean);
    if (entryIds.length > 0) {
        await removeFromJellyfinPlaylist(cfg, playlistId, entryIds);
    }
    if (itemIds.length === 0) return true;
    return addToJellyfinPlaylist(cfg, playlistId, itemIds);
}

/**
 * Remove one item from a Jellyfin playlist by its Jellyfin item id (e.g. from jellyfin:xxx).
 */
export async function removeItemFromJellyfinPlaylistByItemId(
    cfg: JellyfinConfig,
    playlistId: string,
    jellyfinItemId: string
): Promise<boolean> {
    const items = await getJellyfinPlaylistItems(cfg, playlistId);
    const entry = items.find((e) => e.itemId === jellyfinItemId);
    if (!entry) return true; // already not in playlist
    return removeFromJellyfinPlaylist(cfg, playlistId, [entry.entryId]);
}

// --- Favorites ---

export async function addJellyfinFavorite(cfg: JellyfinConfig, itemId: string): Promise<void> {
    const userId = getJellyfinUserId(cfg);
    if (!userId) throw new Error("Jellyfin User ID required for favorites");
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    await client.post(`/Users/${userId}/FavoriteItems/${itemId}`);
}

export async function removeJellyfinFavorite(cfg: JellyfinConfig, itemId: string): Promise<void> {
    const userId = getJellyfinUserId(cfg);
    if (!userId) throw new Error("Jellyfin User ID required for favorites");
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    await client.delete(`/Users/${userId}/FavoriteItems/${itemId}`);
}

/**
 * Fetch multiple Jellyfin items by ID in batch (avoids N+1).
 * @param fields - Optional Fields param; default "Id,Name,ImageTags"
 */
async function getJellyfinItemsBatch(
    cfg: JellyfinConfig,
    itemIds: string[],
    fields: string = "Id,Name,ImageTags"
): Promise<Map<string, JellyfinItem>> {
    const unique = [...new Set(itemIds)].filter(Boolean);
    if (unique.length === 0) return new Map();

    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const BATCH_SIZE = 50;
    const result = new Map<string, JellyfinItem>();

    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
        const batch = unique.slice(i, i + BATCH_SIZE);
        try {
            const res = await client.get<{ Items: JellyfinItem[] }>(path, {
                params: { Ids: batch.join(","), Fields: fields },
            });
            const items = res.data?.Items ?? [];
            for (const item of items) result.set(item.Id, item);
        } catch {
            /* ignore batch errors */
        }
    }
    return result;
}

/** Cache TTL for favorites (2 min) - reduces Jellyfin API load for radio/home */
const FAVORITES_CACHE_TTL = 120;

export async function getJellyfinFavorites(cfg: JellyfinConfig): Promise<ResolvedTrack[]> {
    const userId = getJellyfinUserId(cfg);
    const cacheKey = userId ? `jf:favorites:${userId}` : null;
    if (cacheKey && redisClient.isReady) {
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                return JSON.parse(cached) as ResolvedTrack[];
            }
        } catch {
            /* ignore, fall through */
        }
    }
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const res = await client.get<{ Items: JellyfinItem[] }>(path, {
        params: {
            IncludeItemTypes: "Audio",
            Recursive: "true",
            Filters: "IsFavorite",
            Limit: 500,
            Fields: "Id,Name,RunTimeTicks,AlbumId,AlbumArtist,AlbumArtists,ImageTags,ParentId",
        },
    });
    const items = res.data?.Items ?? [];
    const albumIds = [...new Set(items.map((i) => i.AlbumId).filter(Boolean))] as string[];
    const albumsById = await getJellyfinItemsBatch(cfg, albumIds);

    const tracks: ResolvedTrack[] = [];
    for (const item of items) {
        let album: ResolvedAlbum | undefined;
        if (item.AlbumId) {
            const albumItem = albumsById.get(item.AlbumId);
            if (albumItem)
                album = {
                    id: `${JELLYFIN_PREFIX}${albumItem.Id}`,
                    title: albumItem.Name,
                    coverArt: getJellyfinImageUrl(
                        cfg.url,
                        albumItem.Id,
                        albumItem.ImageTags?.Primary,
                        cfg.apiKey,
                        cfg.userId
                    ),
                };
        }
        tracks.push(
            mapJellyfinItemToTrack(
                item,
                album,
                item.AlbumArtists?.[0]?.Name,
                item.AlbumArtists?.[0] ? `${JELLYFIN_PREFIX}${item.AlbumArtists[0].Id}` : undefined
            )
        );
    }
    if (cacheKey && redisClient.isReady && tracks.length > 0) {
        try {
            await redisClient.setEx(cacheKey, FAVORITES_CACHE_TTL, JSON.stringify(tracks));
        } catch {
            /* ignore */
        }
    }
    return tracks;
}

/**
 * Fetch a batch of Jellyfin tracks with minimal metadata for sync (no cover art).
 * Used by JellyfinTrackMetadata sync. Returns { jellyfinId, artistName, trackTitle, albumTitle, artistMbid?, rgMbid? }.
 * MBIDs are extracted from Jellyfin ProviderIds when available (MusicBrainzArtist, MusicBrainzReleaseGroup).
 */
export async function getJellyfinTracksForSync(
    cfg: JellyfinConfig,
    options: { limit?: number; offset?: number }
): Promise<{
    items: {
        jellyfinId: string;
        artistName: string;
        trackTitle: string;
        albumTitle: string | null;
        artistMbid: string | null;
        rgMbid: string | null;
    }[];
    total: number;
}> {
    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const limit = options.limit ?? 200;
    const offset = options.offset ?? 0;

    const res = await client.get<{ Items: JellyfinItem[]; TotalRecordCount?: number }>(path, {
        params: {
            IncludeItemTypes: "Audio",
            Recursive: "true",
            Limit: limit,
            StartIndex: offset,
            Fields: "Id,Name,AlbumId,AlbumArtist,AlbumArtists",
            EnableTotalRecordCount: true,
        },
    });
    const items = res.data?.Items ?? [];
    const total = res.data?.TotalRecordCount ?? items.length;

    const albumIds = [...new Set(items.map((i) => i.AlbumId).filter(Boolean))] as string[];
    const artistIds = [
        ...new Set(
            items.flatMap((i) => (i.AlbumArtists ?? []).map((a) => a.Id).filter(Boolean))
        ),
    ] as string[];

    const albumsById = await getJellyfinItemsBatch(
        cfg,
        albumIds,
        "Id,Name,ProviderIds"
    );
    const artistsById = await getJellyfinItemsBatch(
        cfg,
        artistIds,
        "Id,Name,ProviderIds"
    );

    const result = items.map((item) => {
        const artistRef = item.AlbumArtists?.[0];
        const artistName = artistRef?.Name ?? item.AlbumArtist ?? "Unknown Artist";
        const albumItem = item.AlbumId ? albumsById.get(item.AlbumId) : undefined;
        const artistItem = artistRef?.Id ? artistsById.get(artistRef.Id) : undefined;
        const albumTitle = albumItem?.Name ?? null;
        const artistMbid = artistItem ? extractArtistMbid(artistItem.ProviderIds) ?? null : null;
        const rgMbid = albumItem ? extractRgMbid(albumItem.ProviderIds) ?? null : null;
        return {
            jellyfinId: `${JELLYFIN_PREFIX}${item.Id}`,
            artistName,
            trackTitle: item.Name,
            albumTitle,
            artistMbid: artistMbid ?? null,
            rgMbid: rgMbid ?? null,
        };
    });

    return { items: result, total };
}

/**
 * Test Jellyfin connection (e.g. for Settings "Test connection"). Uses API key only.
 */
export async function testJellyfinConnection(
    url: string,
    apiKey: string
): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = url.replace(/\/$/, "");
    const token = apiKey?.trim();
    if (!token) {
        return { ok: false, error: "API key is required" };
    }

    const client = axios.create({
        baseURL: baseUrl,
        timeout: 10000,
        headers: jellyfinAuthHeaders(token),
    });
    try {
        await client.get("/System/Info");
        return { ok: true };
    } catch (err: any) {
        const status = err.response?.status;
        const message = err.response?.data?.Message ?? err.message;
        if (status === 401) return { ok: false, error: "Invalid API key" };
        if (status == null) return { ok: false, error: "Could not reach Jellyfin. Check the URL." };
        return { ok: false, error: message || `Jellyfin returned ${status}` };
    }
}
