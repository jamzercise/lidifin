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
 * Get Jellyfin config from system settings. Returns null if not enabled or missing URL/API key.
 */
export async function getJellyfinConfig(): Promise<JellyfinConfig | null> {
    const settings = await getSystemSettings();
    if (
        !settings?.jellyfinEnabled ||
        !settings?.jellyfinUrl?.trim() ||
        !settings?.jellyfinApiKey?.trim()
    ) {
        return null;
    }
    const url = settings.jellyfinUrl.replace(/\/$/, "");
    return {
        enabled: true,
        url,
        apiKey: settings.jellyfinApiKey,
    };
}

export async function isJellyfinMusicSource(): Promise<boolean> {
    const cfg = await getJellyfinConfig();
    return cfg != null;
}

/** Build Jellyfin Authorization header (recommended; avoids 400 with API key on Jellyfin 10.11+). */
function jellyfinAuthHeader(apiKey: string): string {
    return `MediaBrowser Token="${apiKey.replace(/"/g, '\\"')}", Client="Lidifin", Device="Server", DeviceId="lidifin-server", Version="1.0"`;
}

function createClient(baseUrl: string, apiKey: string): AxiosInstance {
    const client = axios.create({
        baseURL: baseUrl,
        timeout: 15000,
        headers: {
            Authorization: jellyfinAuthHeader(apiKey),
            "Content-Type": "application/json",
        },
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
    const client = createClient(cfg.url, cfg.apiKey);
    const params: Record<string, string | number> = {
        IncludeItemTypes: "MusicArtist",
        Recursive: "true",
        Limit: options?.limit ?? 100,
        StartIndex: options?.offset ?? 0,
        Fields: "Id,Name",
    };
    if (options?.search) params.SearchTerm = options.search;
    const res = await client.get<{ Items: JellyfinItem[] }>("/Items", {
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
    const client = createClient(cfg.url, cfg.apiKey);
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
    const res = await client.get<{ Items: JellyfinItem[] }>("/Items", {
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
    const client = createClient(cfg.url, cfg.apiKey);
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
    const res = await client.get<{ Items: JellyfinItem[] }>("/Items", {
        params,
    });
    const items = res.data?.Items ?? [];
    const tracks: ResolvedTrack[] = [];
    for (const item of items) {
        let album: ResolvedAlbum | undefined;
        if (item.AlbumId) {
            try {
                const albumItem = await getJellyfinItem(cfg, item.AlbumId);
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
 */
export async function getJellyfinItem(
    cfg: JellyfinConfig,
    itemId: string
): Promise<JellyfinItem | null> {
    const client = createClient(cfg.url, cfg.apiKey);
    try {
        const res = await client.get<JellyfinItem>(`/Items/${itemId}`, {
            params: { Fields: "Id,Name,Type,RunTimeTicks,AlbumId,AlbumArtist,AlbumArtists,ImageTags,ProductionYear,ParentId" },
        });
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
    const apiKey = cfg.apiKey;
    return `${base}/Audio/${itemId}/stream?api_key=${apiKey}&Static=true`;
}

/**
 * Resolve a single track reference (cuid or jellyfin:xxx) to ResolvedTrack, or null.
 */
export async function resolveTrackReference(trackId: string): Promise<ResolvedTrack | null> {
    if (trackId.startsWith(JELLYFIN_PREFIX)) {
        const cfg = await getJellyfinConfig();
        if (!cfg) return null;
        const rawId = trackId.slice(JELLYFIN_PREFIX.length);
        const item = await getJellyfinItem(cfg, rawId);
        if (!item || item.Type !== "Audio") return null;
        let album: ResolvedAlbum | undefined;
        if (item.AlbumId) {
            const albumItem = await getJellyfinItem(cfg, item.AlbumId);
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
            const client = createClient(cfg.url, cfg.apiKey);
            const res = await client.get<{ Items: JellyfinItem[] }>("/Items", {
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

/** Get Jellyfin current user id (for playlist creation). Returns null if API key doesn't support /Users/Me. */
export async function getJellyfinUserId(cfg: JellyfinConfig): Promise<string | null> {
    const client = createClient(cfg.url, cfg.apiKey);
    try {
        const res = await client.get<{ Id: string }>("/Users/Me");
        return res.data?.Id ?? null;
    } catch (err: any) {
        logger.warn("[Jellyfin] getUserId failed:", err.message);
        return null;
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
    const userId = await getJellyfinUserId(cfg);
    if (!userId) return null;
    const client = createClient(cfg.url, cfg.apiKey);
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
    const client = createClient(cfg.url, cfg.apiKey);
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
    const client = createClient(cfg.url, cfg.apiKey);
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
    const client = createClient(cfg.url, cfg.apiKey);
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
    const client = createClient(cfg.url, cfg.apiKey);
    await client.post(`/UserFavoriteItems/${itemId}`);
}

export async function removeJellyfinFavorite(cfg: JellyfinConfig, itemId: string): Promise<void> {
    const client = createClient(cfg.url, cfg.apiKey);
    await client.delete(`/UserFavoriteItems/${itemId}`);
}

export async function getJellyfinFavorites(cfg: JellyfinConfig): Promise<ResolvedTrack[]> {
    const client = createClient(cfg.url, cfg.apiKey);
    const res = await client.get<{ Items: JellyfinItem[] }>("/Items", {
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
                const albumItem = await getJellyfinItem(cfg, item.AlbumId);
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
 */
export async function testJellyfinConnection(
    url: string,
    apiKey: string
): Promise<{ ok: boolean; error?: string }> {
    const baseUrl = url.replace(/\/$/, "");
    const client = axios.create({
        baseURL: baseUrl,
        timeout: 10000,
        headers: { Authorization: jellyfinAuthHeader(apiKey) },
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
