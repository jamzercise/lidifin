import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { lastFmService } from "../services/lastfm";
import { searchService, normalizeCacheQuery, type SearchResults } from "../services/search";
import {
    getJellyfinConfig,
    getJellyfinArtists,
    getJellyfinAlbums,
    getJellyfinTracks,
    getJellyfinImageUrl,
    type JellyfinConfig,
    type ResolvedArtist,
    type ResolvedAlbum,
    type ResolvedTrack,
} from "../services/jellyfin";
import axios from "axios";
import { redisClient } from "../utils/redis";
import {
    canonicalizeArtistArticleOrder,
    normalizeArtistName,
} from "../utils/artistNormalization";

const router = Router();

function transformSearchResults(serviceResults: SearchResults) {
    return {
        artists: serviceResults.artists,
        albums: serviceResults.albums.map((album) => ({
            id: album.id,
            title: album.title,
            artistId: album.artistId,
            year: album.year,
            coverUrl: album.coverUrl,
            artist: {
                id: album.artistId,
                name: album.artistName,
                mbid: "",
            },
        })),
        tracks: serviceResults.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            albumId: track.albumId,
            duration: track.duration,
            trackNo: 0,
            album: {
                id: track.albumId,
                title: track.albumTitle,
                artistId: track.artistId,
                coverUrl: track.coverUrl ?? null,
                artist: {
                    id: track.artistId,
                    name: track.artistName,
                    mbid: "",
                },
            },
        })),
        playlists: serviceResults.playlists || [],
        audiobooks: serviceResults.audiobooks,
        podcasts: serviceResults.podcasts,
        episodes: serviceResults.episodes,
    };
}

async function searchJellyfin(
    query: string,
    limit: number,
    types: ("artists" | "albums" | "tracks")[],
): Promise<Partial<SearchResults>> {
    const cfg = await getJellyfinConfig();
    if (!cfg) return {};

    const result: Partial<SearchResults> = {};
    const promises: Promise<void>[] = [];

    if (types.includes("artists")) {
        promises.push(
            getJellyfinArtists(cfg, { search: query, limit })
                .then(({ artists }) => {
                    result.artists = artists.map((a) => ({
                        id: a.id,
                        name: a.name,
                        mbid: a.mbid ?? "",
                        heroUrl: a.coverArt ?? null,
                        rank: 0,
                    }));
                })
                .catch((err) => {
                    logger.warn("[SEARCH] Jellyfin artist search failed:", err.message);
                }),
        );
    }

    if (types.includes("albums")) {
        promises.push(
            getJellyfinAlbums(cfg, { search: query, limit })
                .then(({ albums }) => {
                    result.albums = albums.map((a) => ({
                        id: a.id,
                        title: a.title,
                        artistId: a.artist?.id ?? "",
                        artistName: a.artist?.name ?? "",
                        year: a.year ?? null,
                        coverUrl: a.coverArt,
                        rank: 0,
                    }));
                })
                .catch((err) => {
                    logger.warn("[SEARCH] Jellyfin album search failed:", err.message);
                }),
        );
    }

    if (types.includes("tracks")) {
        promises.push(
            getJellyfinTracks(cfg, { search: query, limit })
                .then(({ tracks }) => {
                    result.tracks = tracks.map((t) => ({
                        id: t.id,
                        title: t.title,
                        albumId: t.album?.id ?? "",
                        albumTitle: t.album?.title ?? "",
                        artistId: t.artist?.id ?? "",
                        artistName: t.artist?.name ?? "",
                        duration: t.duration,
                        coverUrl: t.album?.coverArt ?? null,
                        rank: 0,
                    }));
                })
                .catch((err) => {
                    logger.warn("[SEARCH] Jellyfin track search failed:", err.message);
                }),
        );
    }

    await Promise.allSettled(promises);
    return result;
}

function mergeResults(postgres: SearchResults, jellyfin: Partial<SearchResults>): SearchResults {
    const artistKey = (name: string) =>
        normalizeArtistName(canonicalizeArtistArticleOrder(name));

    const seenArtists = new Set<string>();
    const seenAlbums = new Set(postgres.albums.map((a) => `${a.title.toLowerCase()}|${a.artistName.toLowerCase()}`));
    const seenTracks = new Set(postgres.tracks.map((t) => `${t.title.toLowerCase()}|${t.artistName.toLowerCase()}`));

    const mergedArtists: typeof postgres.artists = [];
    for (const a of postgres.artists) {
        const key = artistKey(a.name);
        if (seenArtists.has(key)) continue;
        mergedArtists.push(a);
        seenArtists.add(key);
    }
    for (const a of jellyfin.artists ?? []) {
        const key = artistKey(a.name);
        if (!seenArtists.has(key)) {
            mergedArtists.push(a);
            seenArtists.add(key);
        }
    }

    const mergedAlbums = [...postgres.albums];
    for (const a of jellyfin.albums ?? []) {
        const key = `${a.title.toLowerCase()}|${a.artistName.toLowerCase()}`;
        if (!seenAlbums.has(key)) {
            mergedAlbums.push(a);
            seenAlbums.add(key);
        }
    }

    const mergedTracks = [...postgres.tracks];
    for (const t of jellyfin.tracks ?? []) {
        const key = `${t.title.toLowerCase()}|${t.artistName.toLowerCase()}`;
        if (!seenTracks.has(key)) {
            mergedTracks.push(t);
            seenTracks.add(key);
        }
    }

    return {
        artists: mergedArtists,
        albums: mergedAlbums,
        tracks: mergedTracks,
        playlists: postgres.playlists,
        podcasts: postgres.podcasts,
        audiobooks: postgres.audiobooks,
        episodes: postgres.episodes,
    };
}

router.use(requireAuth);

/**
 * @openapi
 * /search:
 *   get:
 *     summary: Search across your music library
 *     description: Search for artists, albums, tracks, audiobooks, and podcasts in your library using PostgreSQL full-text search
 *     tags: [Search]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         required: true
 *         description: Search query
 *         example: "radiohead"
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [all, artists, albums, tracks, audiobooks, podcasts, episodes]
 *         description: Type of content to search
 *         default: all
 *       - in: query
 *         name: genre
 *         schema:
 *           type: string
 *         description: Filter tracks by genre
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of results per type
 *         default: 20
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Artist'
 *                 albums:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Album'
 *                 tracks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Track'
 *                 audiobooks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 podcasts:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/", async (req, res) => {
    try {
        const { q = "", type = "all", genre, limit = "20" } = req.query;

        const query = (q as string).trim();
        const parsed = parseInt(limit as string, 10);
        const searchLimit = Number.isNaN(parsed) ? 20 : Math.min(Math.max(parsed, 1), 100);

        const userId = req.user!.id;

        if (!query) {
            return res.json({
                artists: [],
                albums: [],
                tracks: [],
                playlists: [],
                audiobooks: [],
                podcasts: [],
                episodes: [],
            });
        }

        const musicTypes: ("artists" | "albums" | "tracks")[] =
            type === "all"
                ? ["artists", "albums", "tracks"]
                : type === "artists" || type === "albums" || type === "tracks"
                  ? [type as "artists" | "albums" | "tracks"]
                  : [];

        const [pgResults, jfResults] = await Promise.all([
            type === "all"
                ? searchService.searchAll({ query, limit: searchLimit, genre: genre as string | undefined, userId })
                : searchService.searchByType({ query, type: type as string, limit: searchLimit, genre: genre as string | undefined, userId }),
            musicTypes.length > 0
                ? searchJellyfin(query, searchLimit, musicTypes)
                : Promise.resolve({}),
        ]);

        const merged = mergeResults(pgResults, jfResults);
        res.json(transformSearchResults(merged));
    } catch (error) {
        logger.error("Search error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

// GET /search/genres
router.get("/genres", async (req, res) => {
    try {
        const genres = await prisma.genre.findMany({
            orderBy: { name: "asc" },
            take: 2000, // Safety cap (genre list is usually small)
            include: {
                _count: {
                    select: { trackGenres: true },
                },
            },
        });

        res.json(
            genres.map((g) => ({
                id: g.id,
                name: g.name,
                trackCount: g._count.trackGenres,
            }))
        );
    } catch (error) {
        logger.error("Get genres error:", error);
        res.status(500).json({ error: "Failed to get genres" });
    }
});

/**
 * GET /search/discover?q=query&type=music|podcasts
 * Search for NEW content to discover (not in your library).
 * Cache TTL: 15 min -- external data changes infrequently.
 */
router.get("/discover", async (req, res) => {
    try {
        const { q = "", type = "music", limit = "20" } = req.query;

        const query = (q as string).trim();
        const parsedLimit = parseInt(limit as string, 10);
        const searchLimit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 50);

        if (!query) {
            return res.json({ results: [], aliasInfo: null });
        }

        // Cache TTL: 15 min (900s) -- external API data rarely changes
        const cacheKey = `search:discover:${type}:${normalizeCacheQuery(query)}:${searchLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH DISCOVER] Cache hit for query="${query}" type=${type}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH DISCOVER] Redis read error:", err);
        }

        const results: any[] = [];

        // Resolve alias (sequential -- modifies the search query, cached 30 days)
        let searchQuery = query;
        let aliasInfo: { original: string; canonical: string; mbid?: string } | null = null;

        if (type === "music" || type === "all") {
            try {
                const correction = await lastFmService.getArtistCorrection(query);
                if (correction?.corrected) {
                    searchQuery = correction.canonicalName;
                    aliasInfo = {
                        original: query,
                        canonical: correction.canonicalName,
                        mbid: correction.mbid,
                    };
                    logger.debug(`[SEARCH DISCOVER] Alias resolved: "${query}" -> "${correction.canonicalName}"`);
                }
            } catch (correctionError) {
                logger.warn("[SEARCH DISCOVER] Correction check failed:", correctionError);
            }
        }

        // Build parallel promises for independent external calls
        const promiseMap: Record<string, Promise<any>> = {};

        if (type === "music" || type === "all") {
            promiseMap.artists = lastFmService.searchArtists(searchQuery, searchLimit);
            promiseMap.tracks = lastFmService.searchTracks(searchQuery, searchLimit);
        }

        if (type === "podcasts" || type === "all") {
            promiseMap.podcasts = axios.get("https://itunes.apple.com/search", {
                params: { term: query, media: "podcast", entity: "podcast", limit: searchLimit },
                timeout: 5000,
            }).then((resp) => resp.data.results.map((podcast: any) => ({
                type: "podcast",
                id: podcast.collectionId,
                name: podcast.collectionName,
                artist: podcast.artistName,
                description: podcast.description,
                coverUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
                feedUrl: podcast.feedUrl,
                genres: podcast.genres || [],
                trackCount: podcast.trackCount,
            })));
        }

        // Await all with allSettled so one failure doesn't block others
        const keys = Object.keys(promiseMap);
        const settled = await Promise.allSettled(keys.map((k) => promiseMap[k]));
        const resolved: Record<string, any[]> = {};
        keys.forEach((k, i) => {
            const result = settled[i];
            if (result.status === "fulfilled") {
                resolved[k] = result.value;
            } else {
                logger.error(`[SEARCH DISCOVER] ${k} search failed:`, result.reason);
                resolved[k] = [];
            }
        });

        if (resolved.artists) {
            logger.debug(`[SEARCH DISCOVER] Found ${resolved.artists.length} artist results`);
            results.push(...resolved.artists);
        }
        if (resolved.tracks) {
            logger.debug(`[SEARCH DISCOVER] Found ${resolved.tracks.length} track results`);
            results.push(...resolved.tracks);
        }
        if (resolved.podcasts) {
            results.push(...resolved.podcasts);
        }

        const payload = { results, aliasInfo };

        try {
            await redisClient.setEx(cacheKey, 900, JSON.stringify(payload));
        } catch (err) {
            logger.warn("[SEARCH DISCOVER] Redis write error:", err);
        }

        res.json(payload);
    } catch (error) {
        logger.error("Discovery search error:", error);
        res.status(500).json({ error: "Discovery search failed" });
    }
});

/**
 * GET /search/discover/similar?artist=name&mbid=xxx
 * Fetch musically similar artists (Last.fm getSimilar).
 * Separate from discover so main search results return immediately.
 * Cache TTL: 7 days -- similar artists change very rarely.
 */
router.get("/discover/similar", async (req, res) => {
    try {
        const { artist = "", mbid = "" } = req.query;
        const artistName = (artist as string).trim();
        const artistMbid = (mbid as string).trim();

        if (!artistName) {
            return res.json({ similarArtists: [] });
        }

        const cacheKey = `search:discover:similar:${normalizeCacheQuery(artistName)}:${artistMbid}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH SIMILAR] Cache hit for artist="${artistName}"`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH SIMILAR] Redis read error:", err);
        }

        const similar = await lastFmService.getSimilarArtists(artistMbid, artistName, 10);
        const similarArtists = similar.length > 0
            ? await lastFmService.enrichSimilarArtists(similar, 6)
            : [];

        const payload = { similarArtists };

        try {
            // Cache TTL: 7 days -- similar artists rarely change
            await redisClient.setEx(cacheKey, 7 * 24 * 60 * 60, JSON.stringify(payload));
        } catch (err) {
            logger.warn("[SEARCH SIMILAR] Redis write error:", err);
        }

        res.json(payload);
    } catch (error) {
        logger.error("Similar artists search error:", error);
        res.status(500).json({ error: "Similar artists search failed" });
    }
});

export default router;
