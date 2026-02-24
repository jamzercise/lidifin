/**
 * Jellyfin API client and DTO mapping for Lidifin (Jellyfin as music library).
 * Maps Jellyfin items to the same shapes the frontend expects (artist, album, track).
 * Track ids are exposed as jellyfin:{jellyfinItemId}.
 */

import axios, { AxiosInstance } from "axios";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

const JELLYFIN_PREFIX = "jellyfin:";

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

/** Extract MusicBrainz artist ID from Jellyfin ProviderIds. */
function extractArtistMbid(providerIds?: Record<string, string | null>): string | undefined {
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
    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const params: Record<string, string | number | boolean> = {
        IncludeItemTypes: "MusicArtist",
        Recursive: "true",
        Limit: options?.limit ?? 100,
        StartIndex: options?.offset ?? 0,
        Fields: "Id,Name,ImageTags,ProviderIds",
        EnableTotalRecordCount: true,
    };
    if (options?.search) params.SearchTerm = options.search;
    const res = await client.get<{ Items: JellyfinItem[]; TotalRecordCount?: number }>(path, {
        params,
    });
    const items = res.data?.Items ?? [];
    const total = res.data?.TotalRecordCount ?? items.length;
    const artists = items.map((a) => ({
        id: `${JELLYFIN_PREFIX}${a.Id}`,
        name: (a.Name && a.Name.trim()) || "Unknown Artist",
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
    }));
    return { artists, total };
}

/**
 * Fetch albums from Jellyfin (MusicAlbum). Optional parentId for artist's albums.
 * Returns { albums, total } where total is TotalRecordCount from the API.
 */
export async function getJellyfinAlbums(
    cfg: JellyfinConfig,
    options?: { limit?: number; offset?: number; artistId?: string; search?: string }
): Promise<{ albums: ResolvedAlbum[]; total: number }> {
    const token = getEffectiveToken(cfg);
    const userId = getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const params: Record<string, string | number | boolean> = {
        IncludeItemTypes: "MusicAlbum",
        Recursive: "true",
        Limit: options?.limit ?? 100,
        StartIndex: options?.offset ?? 0,
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
    return { albums, total };
}

const ALBUMS_PAGE_SIZE = 200;

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

/**
 * Fetch all albums for an artist, paginating through Jellyfin until complete.
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
        const result = await getJellyfinAlbums(cfg, {
            artistId,
            limit: ALBUMS_PAGE_SIZE,
            offset,
        });
        fetched = result.albums;
        total = result.total;
        all.push(...fetched);
        offset += fetched.length;
    } while (all.length < total && fetched.length > 0);
    return all;
}

const TRACKS_PAGE_SIZE = 500;

/**
 * Fetch all tracks for an album, paginating through Jellyfin until complete.
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
        const result = await getJellyfinTracks(cfg, {
            albumId,
            limit: TRACKS_PAGE_SIZE,
            offset,
        });
        fetched = result.tracks;
        total = result.total;
        all.push(...fetched);
        offset += fetched.length;
    } while (all.length < total && fetched.length > 0);
    return all;
}

/**
 * Fetch tracks (Audio) from Jellyfin. Optional albumId or artistId to filter.
 * Returns { tracks, total } where total is TotalRecordCount from the API.
 */
export async function getJellyfinTracks(
    cfg: JellyfinConfig,
    options?: { limit?: number; offset?: number; albumId?: string; artistId?: string; search?: string }
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
    if (cfg && jellyfinIds.length > 0) {
        try {
            const token = getEffectiveToken(cfg);
            const userId = getEffectiveUserId(cfg);
            const client = createClient(cfg.url, token);
            const path = userId ? `/Users/${userId}/Items` : "/Items";
            const res = await client.get<{ Items: JellyfinItem[] }>(path, {
                params: {
                    Ids: jellyfinIds.join(","),
                    Fields: "Id,Name,RunTimeTicks,AlbumId,AlbumArtist,AlbumArtists,ImageTags,ParentId",
                },
            });
            const items = (res.data?.Items ?? []) as JellyfinItem[];
            const byId = new Map(items.map((i) => [i.Id, i]));
            for (let j = 0; j < jellyfinIds.length; j++) {
                const item = byId.get(jellyfinIds[j]);
                const idx = jellyfinIndexes[j];
                if (item && item.Type === "Audio") {
                    result[idx] = mapJellyfinItemToTrack(
                        item,
                        undefined,
                        item.AlbumArtists?.[0]?.Name,
                        item.AlbumArtists?.[0] ? `${JELLYFIN_PREFIX}${item.AlbumArtists[0].Id}` : undefined
                    );
                }
            }
        } catch (err: any) {
            logger.warn("[Jellyfin] batch get items failed:", err.message);
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
        const byId = new Map(nativeTracks.map((t) => [t.id, t]));
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

/** Get Jellyfin user id for API requests (from config; User ID is required when Jellyfin is enabled). */
export function getJellyfinUserId(cfg: JellyfinConfig): string {
    return getEffectiveUserId(cfg);
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
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    await client.post(`/UserFavoriteItems/${itemId}`);
}

export async function removeJellyfinFavorite(cfg: JellyfinConfig, itemId: string): Promise<void> {
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    await client.delete(`/UserFavoriteItems/${itemId}`);
}

export async function getJellyfinFavorites(cfg: JellyfinConfig): Promise<ResolvedTrack[]> {
    const token = getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    const userId = getJellyfinUserId(cfg);
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
        tracks.push(
            mapJellyfinItemToTrack(
                item,
                album,
                item.AlbumArtists?.[0]?.Name,
                item.AlbumArtists?.[0] ? `${JELLYFIN_PREFIX}${item.AlbumArtists[0].Id}` : undefined
            )
        );
    }
    return tracks;
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
