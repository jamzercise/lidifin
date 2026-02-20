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
    /** Optional: use AuthenticateByName for token + User.Id when API key alone fails */
    username?: string | null;
    password?: string | null;
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
}

export interface ResolvedAlbum {
    id: string;
    title: string;
    coverArt: string | null;
    artist?: { id: string; name: string };
    year?: number;
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
}

function runTimeTicksToSeconds(ticks: number | undefined): number {
    if (ticks == null) return 0;
    return Math.floor(ticks / 10_000_000);
}

/**
 * Get Jellyfin config from system settings. Returns null if not enabled or missing URL and auth.
 * Auth: either API key, or username+password (for AuthenticateByName per jmshrv.com guide).
 */
export async function getJellyfinConfig(): Promise<JellyfinConfig | null> {
    const settings = await getSystemSettings();
    if (!settings?.jellyfinEnabled || !settings?.jellyfinUrl?.trim()) return null;
    const hasApiKey = !!(settings.jellyfinApiKey?.trim());
    const hasUserPass =
        !!(settings.jellyfinUsername?.trim() && settings.jellyfinPassword?.trim());
    if (!hasApiKey && !hasUserPass) return null;
    const url = settings.jellyfinUrl.replace(/\/$/, "");
    return {
        enabled: true,
        url,
        apiKey: settings.jellyfinApiKey ?? "",
        username: settings.jellyfinUsername ?? undefined,
        password: settings.jellyfinPassword ?? undefined,
    };
}

export async function isJellyfinMusicSource(): Promise<boolean> {
    const cfg = await getJellyfinConfig();
    return cfg != null;
}

/** In-memory cache for resolved Jellyfin user id (per url+apiKey) when using API key only. */
const jellyfinUserIdCache = new Map<string, string>();

/** Session from AuthenticateByName (per url+username). Guide: jmshrv.com/posts/jellyfin-api */
interface JellyfinSession {
    token: string;
    userId: string;
}
const jellyfinSessionByUser = new Map<string, JellyfinSession>();

/**
 * Clear in-memory Jellyfin auth caches. Call when system settings (URL, API key, username, password) change
 * so the next request uses fresh credentials.
 */
export function clearJellyfinSessionCache(): void {
    jellyfinUserIdCache.clear();
    jellyfinSessionByUser.clear();
    logger.debug("[Jellyfin] Session and user id caches cleared");
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

/**
 * Authenticate with username/password per guide (AuthenticateByName). Returns token + User.Id.
 * Cached per url+username. Use when API key alone returns 400 for /Users/Me or item requests.
 */
async function authenticateByName(cfg: JellyfinConfig): Promise<JellyfinSession | null> {
    if (!cfg.username?.trim() || !cfg.password?.trim()) return null;
    const cacheKey = `${cfg.url}:${cfg.username}`;
    const cached = jellyfinSessionByUser.get(cacheKey);
    if (cached) return cached;

    const client = axios.create({
        baseURL: cfg.url,
        timeout: 10000,
        headers: { "Content-Type": "application/json" },
    });
    try {
        const res = await client.post<{
            AccessToken?: string;
            User?: { Id?: string };
        }>("/Users/AuthenticateByName", {
            Username: cfg.username.trim(),
            Pw: cfg.password.trim(),
        });
        const token = res.data?.AccessToken?.trim();
        const userId = res.data?.User?.Id?.trim();
        if (!token || !userId) {
            logger.warn("[Jellyfin] AuthenticateByName missing AccessToken or User.Id");
            return null;
        }
        const session: JellyfinSession = { token, userId };
        jellyfinSessionByUser.set(cacheKey, session);
        logger.debug("[Jellyfin] AuthenticateByName succeeded, userId:", userId);
        return session;
    } catch (err: any) {
        logger.warn("[Jellyfin] AuthenticateByName failed:", err?.message);
        return null;
    }
}

/**
 * Resolve the token to use for requests (session token from AuthenticateByName or API key).
 */
async function getEffectiveToken(cfg: JellyfinConfig): Promise<string> {
    if (cfg.username?.trim() && cfg.password?.trim()) {
        const session = await authenticateByName(cfg);
        if (session) return session.token;
    }
    return cfg.apiKey;
}

/**
 * When using username+password we have userId from AuthenticateByName. Otherwise resolve via API.
 */
async function getEffectiveUserId(cfg: JellyfinConfig): Promise<string | null> {
    if (cfg.username?.trim() && cfg.password?.trim()) {
        const session = await authenticateByName(cfg);
        if (session) return session.userId;
    }
    return getJellyfinUserIdWithApiKey(cfg);
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
 */
export function getJellyfinImageUrl(
    baseUrl: string,
    itemId: string,
    tag?: string,
    apiKey?: string
): string {
    const path = tag
        ? `/Items/${itemId}/Images/Primary?tag=${tag}`
        : `/Items/${itemId}/Images/Primary`;
    const sep = baseUrl.includes("?") ? "&" : "?";
    const auth = apiKey ? `${sep}api_key=${apiKey}` : "";
    return `${baseUrl}${path}${auth}`;
}

/**
 * Fetch artists from Jellyfin (MusicArtist).
 */
export async function getJellyfinArtists(
    cfg: JellyfinConfig,
    options?: { limit?: number; offset?: number; search?: string }
): Promise<ResolvedArtist[]> {
    const token = await getEffectiveToken(cfg);
    const userId = await getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const params: Record<string, string | number> = {
        IncludeItemTypes: "MusicArtist",
        Recursive: "true",
        Limit: options?.limit ?? 100,
        StartIndex: options?.offset ?? 0,
        Fields: "Id,Name",
    };
    if (options?.search) params.SearchTerm = options.search;
    const res = await client.get<{ Items: JellyfinItem[] }>(path, {
        params,
    });
    const items = res.data?.Items ?? [];
    return items.map((a) => ({
        id: `${JELLYFIN_PREFIX}${a.Id}`,
        name: a.Name,
    }));
}

/**
 * Fetch albums from Jellyfin (MusicAlbum). Optional parentId for artist's albums.
 */
export async function getJellyfinAlbums(
    cfg: JellyfinConfig,
    options?: { limit?: number; offset?: number; artistId?: string; search?: string }
): Promise<ResolvedAlbum[]> {
    const token = await getEffectiveToken(cfg);
    const userId = await getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const params: Record<string, string | number> = {
        IncludeItemTypes: "MusicAlbum",
        Recursive: "true",
        Limit: options?.limit ?? 100,
        StartIndex: options?.offset ?? 0,
        Fields: "Id,Name,ProductionYear,AlbumArtists,ParentId",
    };
    if (options?.artistId) {
        const rawId = options.artistId.startsWith(JELLYFIN_PREFIX)
            ? options.artistId.slice(JELLYFIN_PREFIX.length)
            : options.artistId;
        params.ParentId = rawId;
    }
    if (options?.search) params.SearchTerm = options.search;
    const res = await client.get<{ Items: JellyfinItem[] }>(path, {
        params,
    });
    const items = res.data?.Items ?? [];
    return items.map((a) => ({
        id: `${JELLYFIN_PREFIX}${a.Id}`,
        title: a.Name,
        coverArt: getJellyfinImageUrl(cfg.url, a.Id, a.ImageTags?.Primary, cfg.apiKey),
        artist: a.AlbumArtists?.[0]
            ? { id: `${JELLYFIN_PREFIX}${a.AlbumArtists[0].Id}`, name: a.AlbumArtists[0].Name }
            : undefined,
        year: a.ProductionYear ?? undefined,
    }));
}

/**
 * Fetch tracks (Audio) from Jellyfin. Optional albumId or artistId to filter.
 */
export async function getJellyfinTracks(
    cfg: JellyfinConfig,
    options?: { limit?: number; offset?: number; albumId?: string; artistId?: string; search?: string }
): Promise<ResolvedTrack[]> {
    const token = await getEffectiveToken(cfg);
    const userId = await getEffectiveUserId(cfg);
    const client = createClient(cfg.url, token);
    const path = userId ? `/Users/${userId}/Items` : "/Items";
    const params: Record<string, string | number> = {
        IncludeItemTypes: "Audio",
        Recursive: "true",
        Limit: options?.limit ?? 100,
        StartIndex: options?.offset ?? 0,
        Fields: "Id,Name,RunTimeTicks,AlbumId,AlbumArtist,AlbumArtists,ImageTags,ParentId",
    };
    if (options?.albumId) {
        const rawId = options.albumId.startsWith(JELLYFIN_PREFIX)
            ? options.albumId.slice(JELLYFIN_PREFIX.length)
            : options.albumId;
        params.ParentId = rawId;
    }
    if (options?.search) params.SearchTerm = options.search;
    const res = await client.get<{ Items: JellyfinItem[] }>(path, {
        params,
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
                            cfg.apiKey
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
    return tracks;
}

/**
 * Get a single item by id (raw Jellyfin id, no prefix).
 * Uses effective token (session or API key) and user-scoped path when available.
 */
export async function getJellyfinItem(
    cfg: JellyfinConfig,
    itemId: string,
    _itemType?: "MusicAlbum" | "Audio"
): Promise<JellyfinItem | null> {
    const token = await getEffectiveToken(cfg);
    const userId = await getEffectiveUserId(cfg);
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
    const token = await getEffectiveToken(cfg);
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
                        cfg.apiKey
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
            const token = await getEffectiveToken(cfg);
            const userId = await getEffectiveUserId(cfg);
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

/**
 * Resolve user id when using API key only (/Users/Me then GET /Users fallback). Cached per url+apiKey.
 */
async function getJellyfinUserIdWithApiKey(cfg: JellyfinConfig): Promise<string | null> {
    const cacheKey = `${cfg.url}:${cfg.apiKey}`;
    const cached = jellyfinUserIdCache.get(cacheKey);
    if (cached) return cached;

    const token = await getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        const res = await client.get<{ Id: string }>("/Users/Me");
        if (res.data?.Id) {
            jellyfinUserIdCache.set(cacheKey, res.data.Id);
            return res.data.Id;
        }
    } catch (err: any) {
        if (err.response?.status === 400) {
            logger.debug("[Jellyfin] /Users/Me returned 400 (common with API key), trying GET /Users");
        } else {
            logger.warn("[Jellyfin] getUserId (/Users/Me) failed:", err.message);
        }
    }
    try {
        const res = await client.get<{ Items?: JellyfinUser[] }>("/Users");
        const users = res.data?.Items ?? [];
        const first = users.find((u) => u?.Id) ?? users[0];
        if (first?.Id) {
            logger.debug("[Jellyfin] Using user from GET /Users:", first.Id);
            jellyfinUserIdCache.set(cacheKey, first.Id);
            return first.Id;
        }
    } catch (err: any) {
        logger.warn("[Jellyfin] GET /Users fallback failed:", err.message);
    }
    return null;
}

/**
 * Get Jellyfin user id for API requests. Uses AuthenticateByName session when username+password set;
 * otherwise API key with /Users/Me and GET /Users fallback.
 */
export async function getJellyfinUserId(cfg: JellyfinConfig): Promise<string | null> {
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
    const userId = await getJellyfinUserId(cfg);
    if (!userId) return null;
    const token = await getEffectiveToken(cfg);
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
    const userId = await getJellyfinUserId(cfg);
    if (!userId) return false;
    const token = await getEffectiveToken(cfg);
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
    const token = await getEffectiveToken(cfg);
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
    const token = await getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    try {
        const res = await client.get<{ Items?: { Id: string; PlaylistItemId?: string }[] }>(
            `/Playlists/${playlistId}/Items`,
            { params: { UserId: (await getJellyfinUserId(cfg)) ?? "" } }
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
    const token = await getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    await client.post(`/UserFavoriteItems/${itemId}`);
}

export async function removeJellyfinFavorite(cfg: JellyfinConfig, itemId: string): Promise<void> {
    const token = await getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    await client.delete(`/UserFavoriteItems/${itemId}`);
}

export async function getJellyfinFavorites(cfg: JellyfinConfig): Promise<ResolvedTrack[]> {
    const token = await getEffectiveToken(cfg);
    const client = createClient(cfg.url, token);
    const userId = await getJellyfinUserId(cfg);
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
                            cfg.apiKey
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
 * Test Jellyfin connection (e.g. for Settings "Test connection").
 * Supports either apiKey or (username + password) via AuthenticateByName.
 */
export async function testJellyfinConnection(
    url: string,
    apiKey: string,
    options?: { username?: string; password?: string }
): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = url.replace(/\/$/, "");
    let token: string;

    if (options?.username?.trim() && options?.password?.trim()) {
        try {
            const res = await axios.post<{ AccessToken?: string }>(
                `${baseUrl}/Users/AuthenticateByName`,
                { Username: options.username.trim(), Pw: options.password.trim() },
                { timeout: 10000, headers: { "Content-Type": "application/json" } }
            );
            const rawToken = res.data?.AccessToken?.trim();
            if (!rawToken) {
                return { ok: false, error: "AuthenticateByName did not return a token" };
            }
            token = rawToken;
        } catch (err: any) {
            const status = err.response?.status;
            const message = err.response?.data?.Message ?? err.message;
            if (status === 401) return { ok: false, error: "Invalid username or password" };
            if (status == null) return { ok: false, error: "Could not reach Jellyfin. Check the URL." };
            return { ok: false, error: message || `Jellyfin returned ${status}` };
        }
    } else if (apiKey?.trim()) {
        token = apiKey.trim();
    } else {
        return { ok: false, error: "Provide either API key or username and password" };
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
        if (status === 401) return { ok: false, error: "Invalid API key or session" };
        if (status == null) return { ok: false, error: "Could not reach Jellyfin. Check the URL." };
        return { ok: false, error: message || `Jellyfin returned ${status}` };
    }
}
