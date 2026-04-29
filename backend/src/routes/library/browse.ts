import { Router } from "express";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { config } from "../../config";
import {
    getJellyfinConfig,
    isJellyfinMusicSource,
    getJellyfinAlbums,
    getJellyfinDecades,
    getJellyfinTracks,
    getJellyfinTracksByDecade,
    getJellyfinFavorites,
    getJellyfinArtistImagesBatch,
    resolveTrackReference,
    resolveTrackReferences,
} from "../../services/jellyfin";
import { dataCacheService } from "../../services/dataCache";
import { shuffleArray } from "../../utils/shuffle";
import { getSystemSettings } from "../../utils/systemSettings";
import { getMergedGenres } from "../../utils/metadataOverrides";
import { getDecadeWhereClause } from "../../utils/dateFilters";
import { logger, JELLYFIN_UNREACHABLE_MESSAGE } from "./_helpers";

const router = Router();

const GENRES_ARTIST_NAMES_CAP = 5000;
const LIBRARY_VIBES_CACHE_KEY = "library:vibes:counts";
const LIBRARY_VIBES_CACHE_TTL = 6 * 60 * 60; // 6 hours – vibes/genres change rarely

router.get("/recently-listened", async (req, res) => {
    try {
        const { limit = "10" } = req.query;
        const userId = req.user!.id;
        const limitNum = Math.min(
            Math.max(1, parseInt(limit as string, 10) || 10),
            100
        ); // Cap so take values stay bounded (e.g. limitNum * 3 for plays)

        const [recentPlays, inProgressAudiobooks, inProgressPodcasts] =
            await Promise.all([
                prisma.play.findMany({
                    where: {
                        userId,
                        source: { in: ["LIBRARY", "DISCOVERY_KEPT"] },
                    },
                    orderBy: { playedAt: "desc" },
                    take: limitNum * 3,
                }),
                prisma.audiobookProgress.findMany({
                    where: {
                        userId,
                        isFinished: false,
                        currentTime: { gt: 0 }, // Only show if actually started
                    },
                    orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
                    take: Math.ceil(limitNum / 3), // Get up to 1/3 for audiobooks
                }),
                prisma.podcastProgress.findMany({
                    where: {
                        userId,
                        isFinished: false,
                        currentTime: { gt: 0 }, // Only show if actually started
                    },
                    orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
                    take: limitNum * 2, // Get extra to account for deduplication
                    include: {
                        episode: {
                            include: {
                                podcast: {
                                    select: {
                                        id: true,
                                        title: true,
                                        author: true,
                                        imageUrl: true,
                                    },
                                },
                            },
                        },
                    },
                }),
            ]);

        // Deduplicate podcasts - keep only the most recently played episode per podcast
        const seenPodcasts = new Set();
        const uniquePodcasts = inProgressPodcasts
            .filter((pp) => {
                const podcastId = pp.episode.podcast.id;
                if (seenPodcasts.has(podcastId)) {
                    return false;
                }
                seenPodcasts.add(podcastId);
                return true;
            })
            .slice(0, Math.ceil(limitNum / 3)); // Limit to 1/3 after deduplication

        // Resolve track references (jellyfin:xxx or native) for recent plays
        const trackIds = recentPlays.map((p) => p.trackId).filter(Boolean);
        const resolvedTracks = await resolveTrackReferences(trackIds);
        const trackByIndex = new Map(
            recentPlays.map((p, i) => [i, { play: p, track: resolvedTracks[i] }])
        );

        const items: any[] = [];
        const artistsMap = new Map();

        for (let i = 0; i < recentPlays.length; i++) {
            const { play, track } = trackByIndex.get(i) ?? { play: recentPlays[i], track: null };
            if (!track?.artist) continue;
            const artist = track.artist;
            if (!artistsMap.has(artist.id)) {
                artistsMap.set(artist.id, {
                    id: artist.id,
                    name: artist.name,
                    mbid: undefined,
                    heroUrl: null,
                    userHeroUrl: null,
                    type: "artist",
                    lastPlayedAt: play.playedAt,
                });
            }
            if (artistsMap.size >= limitNum) break;
        }

        // Combine artists, audiobooks, and podcasts
        const combined = [
            ...Array.from(artistsMap.values()),
            ...inProgressAudiobooks.map((ab: any) => {
                // For audiobooks, prefix the path with 'audiobook__' so the frontend knows to use the audiobook endpoint
                const coverArt =
                    ab.coverUrl && !ab.coverUrl.startsWith("http")
                        ? `audiobook__${ab.coverUrl}`
                        : ab.coverUrl;

                return {
                    id: ab.audiobookshelfId,
                    name: ab.title,
                    coverArt,
                    type: "audiobook",
                    author: ab.author,
                    progress:
                        ab.duration > 0
                            ? Math.round((ab.currentTime / ab.duration) * 100)
                            : 0,
                    lastPlayedAt: ab.lastPlayedAt,
                };
            }),
            ...uniquePodcasts.map((pp: any) => ({
                id: pp.episode.podcast.id,
                episodeId: pp.episodeId,
                name: pp.episode.podcast.title,
                coverArt: pp.episode.podcast.imageUrl,
                type: "podcast",
                author: pp.episode.podcast.author,
                progress:
                    pp.duration > 0
                        ? Math.round((pp.currentTime / pp.duration) * 100)
                        : 0,
                lastPlayedAt: pp.lastPlayedAt,
            })),
        ];

        // Sort by lastPlayedAt and limit
        combined.sort(
            (a, b) =>
                new Date(b.lastPlayedAt).getTime() -
                new Date(a.lastPlayedAt).getTime()
        );
        const limitedItems = combined.slice(0, limitNum);

        // Get album counts for artists (Prisma only - Jellyfin artists get 0)
        const artistIds = limitedItems
            .filter((item) => item.type === "artist")
            .map((item) => item.id);
        const prismaArtistIds = artistIds.filter((id) => !id.startsWith("jellyfin:"));
        const albumCounts =
            prismaArtistIds.length > 0
                ? await prisma.album.groupBy({
                      by: ["artistId"],
                      where: {
                          artistId: { in: prismaArtistIds },
                          tracks: { some: {} },
                      },
                      _count: { id: true },
                  })
                : [];
        const albumCountMap = new Map(
            albumCounts.map((ac) => [ac.artistId, ac._count.id])
        );

        // Get artist images: DataCache for Prisma, Jellyfin batch for jellyfin: ids
        let artistImageMap = new Map<string, string | null>();
        const jellyfinArtistIds = artistIds.filter((id) => id.startsWith("jellyfin:"));
        if (jellyfinArtistIds.length > 0) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                const jellyfinImages = await getJellyfinArtistImagesBatch(
                    cfg,
                    jellyfinArtistIds
                );
                jellyfinImages.forEach((url, id) => artistImageMap.set(id, url));
            }
        }
        if (prismaArtistIds.length > 0) {
            const prismaArtists = await prisma.artist.findMany({
                where: { id: { in: prismaArtistIds } },
                select: { id: true, heroUrl: true, userHeroUrl: true },
            });
            const cacheImages = await dataCacheService.getArtistImagesBatch(
                prismaArtists.map((a) => ({
                    id: a.id,
                    heroUrl: a.heroUrl,
                    userHeroUrl: a.userHeroUrl,
                }))
            );
            cacheImages.forEach((url, id) => artistImageMap.set(id, url));
        }

        // Map results with images and album counts
        const results = limitedItems.map((item) => {
            if (item.type === "audiobook" || item.type === "podcast") {
                return item;
            } else {
                const coverArt =
                    item.userHeroUrl ??
                    item.heroUrl ??
                    artistImageMap.get(item.id) ??
                    null;
                return {
                    ...item,
                    coverArt,
                    albumCount: albumCountMap.get(item.id) || 0,
                };
            }
        });

        res.json({ items: results });
    } catch (error) {
        logger.error("Get recently listened error:", error);
        res.status(500).json({ error: "Failed to fetch recently listened" });
    }
});

// GET /library/recently-added?limit=10
// Returns recently added albums (from Jellyfin or native library)
router.get("/recently-added", async (req, res) => {
    try {
        const { limit = "10" } = req.query;
        const limitNum = Math.min(
            Math.max(1, parseInt(limit as string, 10) || 10),
            100
        );

        if (await isJellyfinMusicSource()) {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
            const { albums } = await getJellyfinAlbums(cfg, {
                limit: limitNum,
                offset: 0,
                sortBy: "DateCreated",
                sortOrder: "Descending",
            });
            return res.json({
                albums: albums.map((a) => ({
                    id: a.id,
                    title: a.title,
                    coverArt: a.coverArt,
                    year: a.year,
                    artist: a.artist,
                    rgMbid: a.rgMbid,
                })),
            });
        }

        // Native: get most recently added LIBRARY albums (by lastSynced)
        const recentAlbums = await prisma.album.findMany({
            where: {
                tracks: { some: {} },
            },
            orderBy: { lastSynced: "desc" },
            take: limitNum,
            include: {
                artist: {
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                    },
                },
            },
        });

        const albums = recentAlbums.map((a) => ({
            id: a.id,
            title: a.title,
            coverArt: a.userCoverUrl ?? a.coverUrl ?? null,
            year: a.year ?? undefined,
            artist: a.artist
                ? { id: a.artist.id, mbid: a.artist.mbid ?? undefined, name: a.artist.name }
                : undefined,
            rgMbid: a.rgMbid,
        }));

        res.json({ albums });
    } catch (error) {
        logger.error("Get recently added error:", error);
        res.status(500).json({ error: "Failed to fetch recently added" });
    }
});

router.get("/genres", async (req, res) => {
    try {
        const minTracks = 15; // Minimum tracks for a genre to show up

        // Jellyfin music source: aggregate from JellyfinTrackMetadata.genres
        if (await isJellyfinMusicSource()) {
            const genreResults = await prisma.$queryRaw<
                { genre: string; track_count: bigint }[]
            >`
                SELECT LOWER(g.genre)::text as genre, COUNT(DISTINCT j."jellyfinId")::bigint as track_count
                FROM "JellyfinTrackMetadata" j
                CROSS JOIN LATERAL unnest(j."genres") AS g(genre)
                WHERE j."genres" IS NOT NULL AND array_length(j."genres", 1) > 0
                GROUP BY LOWER(g.genre)::text
                HAVING COUNT(DISTINCT j."jellyfinId") >= ${minTracks}
                ORDER BY track_count DESC
                LIMIT 20
            `;
            const genres = genreResults.map((row) => ({
                genre: row.genre,
                count: Number(row.track_count),
            }));
            logger.debug(
                `[Genres] Found ${genres.length} genres from JellyfinTrackMetadata (min ${minTracks} tracks)`,
            );
            return res.json({ genres });
        }

        // Prisma/Lidarr: use Artist.genres
        const artists = await prisma.artist.findMany({
            select: { name: true, normalizedName: true },
            take: GENRES_ARTIST_NAMES_CAP,
        });
        const artistNames = new Set(
            artists.flatMap((a) =>
                [a.name.toLowerCase(), a.normalizedName?.toLowerCase()].filter(
                    Boolean
                )
            )
        );

        const genreResults = await prisma.$queryRaw<
            { genre: string; track_count: bigint }[]
        >`
            SELECT LOWER(g.genre) as genre, COUNT(DISTINCT t.id) as track_count
            FROM "Artist" ar
            CROSS JOIN LATERAL jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
            JOIN "Album" a ON a."artistId" = ar.id
            JOIN "Track" t ON t."albumId" = a.id
            WHERE ar.genres IS NOT NULL
            GROUP BY LOWER(g.genre)
            HAVING COUNT(DISTINCT t.id) >= ${minTracks}
            ORDER BY track_count DESC
            LIMIT 20
        `;

        const genres = genreResults
            .map((row) => ({
                genre: row.genre,
                count: Number(row.track_count),
            }))
            .filter((g) => !artistNames.has(g.genre.toLowerCase()));

        logger.debug(
            `[Genres] Found ${genres.length} genres from Artist.genres (min ${minTracks} tracks)`,
        );

        res.json({ genres });
    } catch (error) {
        logger.error("Genres endpoint error:", error);
        res.status(500).json({ error: "Failed to get genres" });
    }
});

/**
 * GET /library/decades
 * Get available decades in the library with track counts
 * Returns only decades with enough tracks (15+)
 * When Jellyfin is music source, fetches from Jellyfin; otherwise uses Prisma.
 */
router.get("/decades", async (req, res) => {
    try {
        if (await isJellyfinMusicSource()) {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res.json({ decades: [] });
            }
            const decades = await getJellyfinDecades(cfg);
            return res.json({ decades });
        }

        // Prisma/Lidarr: compute decades from Album table
        const decadeRows = await prisma.$queryRaw<
            { decade_start: number; track_count: bigint }[]
        >`
            SELECT
                (FLOOR(COALESCE(a."displayYear", a."originalYear", a."year", 0) / 10) * 10)::int AS decade_start,
                COUNT(t.id)::bigint AS track_count
            FROM "Album" a
            JOIN "Track" t ON t."albumId" = a.id
            WHERE COALESCE(a."displayYear", a."originalYear", a."year") IS NOT NULL
            AND COALESCE(a."displayYear", a."originalYear", a."year") > 0
            GROUP BY decade_start
            HAVING COUNT(t.id) >= 15
            ORDER BY decade_start ASC
        `;

        const decadeMap = new Map<number, number>();
        for (const row of decadeRows) {
            decadeMap.set(row.decade_start, Number(row.track_count));
        }

        const decades = Array.from(decadeMap.entries())
            .map(([decade, count]) => ({ decade, count }))
            .sort((a, b) => b.decade - a.decade);

        res.json({ decades });
    } catch (error) {
        logger.error("Decades endpoint error:", error);
        res.status(500).json({ error: "Failed to get decades" });
    }
});

/**
 * GET /library/vibes
 * Returns aggregate counts of Last.fm mood tags in the library.
 * Used by Radio Vibes section to show available vibe stations.
 * Cached in Redis for 6 hours.
 */
router.get("/vibes", async (req, res) => {
    try {
        if (await isJellyfinMusicSource()) {
            // Jellyfin: aggregate from JellyfinTrackMetadata (Last.fm tags from sync+enrichment)
            const cacheKey = LIBRARY_VIBES_CACHE_KEY + ":jellyfin";
            if (redisClient.isReady) {
                try {
                    const cached = await redisClient.get(cacheKey);
                    if (cached) {
                        return res.json(JSON.parse(cached));
                    }
                } catch (err) {
                    /* ignore cache errors */
                }
            }
            const vibes = await prisma.$queryRaw<
                { tag: string; count: bigint }[]
            >`
                SELECT unnest("lastfmTags") AS tag, count(*) AS count
                FROM "JellyfinTrackMetadata"
                WHERE "lastfmTags" IS NOT NULL
                  AND array_length("lastfmTags", 1) > 0
                  AND NOT ("lastfmTags" @> ARRAY['_no_mood_tags'])
                  AND NOT ("lastfmTags" @> ARRAY['_not_found'])
                GROUP BY tag
                ORDER BY count DESC
                LIMIT 40
            `;
            const result = {
                vibes: vibes.map((v) => ({ tag: v.tag, count: Number(v.count) })),
            };
            if (redisClient.isReady) {
                try {
                    await redisClient.setEx(
                        cacheKey,
                        LIBRARY_VIBES_CACHE_TTL,
                        JSON.stringify(result)
                    );
                } catch (err) {
                    /* ignore */
                }
            }
            return res.json(result);
        }

        const cacheKey = LIBRARY_VIBES_CACHE_KEY;
        if (redisClient.isReady) {
            try {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    return res.json(JSON.parse(cached));
                }
            } catch (err) {
                // ignore cache errors
            }
        }

        const vibes = await prisma.$queryRaw<
            { tag: string; count: bigint }[]
        >`
            SELECT unnest("lastfmTags") AS tag, count(*) AS count
            FROM "Track"
            WHERE "lastfmTags" IS NOT NULL
              AND array_length("lastfmTags", 1) > 0
              AND NOT ("lastfmTags" @> ARRAY['_no_mood_tags'])
              AND NOT ("lastfmTags" @> ARRAY['_not_found'])
            GROUP BY tag
            ORDER BY count DESC
            LIMIT 40
        `;

        const result = {
            vibes: vibes.map((v) => ({
                tag: v.tag,
                count: Number(v.count),
            })),
        };

        if (redisClient.isReady) {
            try {
                await redisClient.setEx(
                    cacheKey,
                    LIBRARY_VIBES_CACHE_TTL,
                    JSON.stringify(result)
                );
            } catch (err) {
                // ignore
            }
        }

        return res.json(result);
    } catch (error: any) {
        logger.error("Vibes endpoint error:", error?.message || error);
        res.status(500).json({ error: "Failed to get vibes" });
    }
});

/**
 * GET /library/radio
 * Get tracks for a library-based radio station
 *
 * Query params:
 * - type: "discovery" | "favorites" | "decade" | "genre" | "mood"
 * - value: Optional value for decade (e.g., "1990") or genre name
 * - limit: Number of tracks to return (default 50)
 */
router.get("/radio", async (req, res) => {
    try {
        const { type, value, limit = "50" } = req.query;
        const limitNum = Math.min(parseInt(limit as string) || 50, 100);
        const userId = req.user?.id;

        if (!type) {
            return res.status(400).json({ error: "Radio type is required" });
        }

        // Jellyfin music source: prefer JellyfinTrackMetadata (fast DB) over Jellyfin API (slow)
        if (await isJellyfinMusicSource()) {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
            let jellyfinTracks: Awaited<ReturnType<typeof getJellyfinTracks>>["tracks"] = [];
            const takeCount = limitNum * 2;

            // Genre: JellyfinTrackMetadata.genres (indexed, fast)
            if (type === "genre" && value) {
                const genreValue = ((value as string) || "").toLowerCase();
                const genreRows = await prisma.jellyfinTrackMetadata.findMany({
                    where: { genres: { has: genreValue } },
                    select: { jellyfinId: true },
                    take: takeCount,
                });
                const trackIds = genreRows.map((r) => r.jellyfinId);
                if (trackIds.length > 0) {
                    const resolved = await resolveTrackReferences(trackIds);
                    jellyfinTracks = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
                    logger.debug(`[Radio:genre] Jellyfin: ${jellyfinTracks.length} tracks for "${genreValue}"`);
                }
            }

            // Mood: JellyfinTrackMetadata.lastfmTags with expanded synonyms (chill→chillout/relaxing, etc.)
            const MOOD_TAG_MAP: Record<string, string[]> = {
                chill: ["chill", "chillout", "relaxing", "calm", "mellow", "ambient", "chill-out"],
                energetic: ["energetic", "high energy", "upbeat", "powerful"],
                sad: ["sad", "melancholy", "depressing", "dark", "melancholic"],
                romantic: ["romantic", "love", "love songs", "romance"],
                study: ["study", "focus", "ambient", "instrumental", "background", "concentration"],
                driving: ["driving", "road trip", "road", "highway"],
            };
            if (type === "mood" && value && jellyfinTracks.length === 0) {
                const moodValue = ((value as string) || "").toLowerCase();
                const tags = MOOD_TAG_MAP[moodValue] ?? [moodValue];
                const moodRows = await prisma.jellyfinTrackMetadata.findMany({
                    where: {
                        AND: [
                            { lastfmTags: { hasSome: tags } },
                            { NOT: { lastfmTags: { has: "_no_mood_tags" } } },
                            { NOT: { lastfmTags: { has: "_not_found" } } },
                        ],
                    },
                    select: { jellyfinId: true },
                    take: takeCount,
                });
                const trackIds = moodRows.map((r) => r.jellyfinId);
                if (trackIds.length > 0) {
                    const resolved = await resolveTrackReferences(trackIds);
                    jellyfinTracks = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
                    logger.debug(`[Radio:mood] Jellyfin: ${jellyfinTracks.length} tracks for "${moodValue}"`);
                }
            }

            // Workout: JellyfinTrackMetadata.genres (high-energy genres)
            const WORKOUT_GENRES = ["rock", "metal", "electronic", "edm", "hip hop", "rap", "punk", "hard rock", "techno", "house"];
            if (type === "workout" && jellyfinTracks.length === 0) {
                const workoutRows = await prisma.jellyfinTrackMetadata.findMany({
                    where: { genres: { hasSome: WORKOUT_GENRES } },
                    select: { jellyfinId: true },
                    take: takeCount,
                });
                const trackIds = workoutRows.map((r) => r.jellyfinId);
                if (trackIds.length > 0) {
                    const resolved = await resolveTrackReferences(trackIds);
                    jellyfinTracks = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
                    logger.debug(`[Radio:workout] Jellyfin: ${jellyfinTracks.length} tracks`);
                }
            }

            // All / Discovery: random from JellyfinTrackMetadata (avoids slow Jellyfin API)
            if ((type === "all" || type === "discovery") && jellyfinTracks.length === 0) {
                const randomRows = await prisma.$queryRaw<{ jellyfinId: string }[]>`
                    SELECT "jellyfinId" FROM "JellyfinTrackMetadata"
                    WHERE "jellyfinId" IS NOT NULL AND "jellyfinId" != ''
                    ORDER BY RANDOM()
                    LIMIT ${takeCount}
                `;
                const trackIds = randomRows.map((r) => r.jellyfinId);
                if (trackIds.length > 0) {
                    const resolved = await resolveTrackReferences(trackIds);
                    jellyfinTracks = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
                    logger.debug(`[Radio:${type}] Jellyfin: ${jellyfinTracks.length} tracks from metadata`);
                }
            }

            // Favorites: Jellyfin API (user-scoped, no local alternative)
            if (type === "favorites" && jellyfinTracks.length === 0) {
                jellyfinTracks = await getJellyfinFavorites(cfg);
            }

            // Decade: Jellyfin API filtered by ProductionYear
            if (type === "decade" && value && jellyfinTracks.length === 0) {
                const decadeStart = parseInt(value as string) || 2000;
                jellyfinTracks = await getJellyfinTracksByDecade(
                    cfg,
                    decadeStart,
                    limitNum
                );
                logger.debug(
                    `[Radio:decade] Jellyfin: ${jellyfinTracks.length} tracks for ${decadeStart}s`
                );
            }

            // Fallback: Jellyfin API only when metadata has no matches
            if (jellyfinTracks.length === 0) {
                const { tracks } = await getJellyfinTracks(cfg, { limit: takeCount, sortBy: "Random" });
                jellyfinTracks = tracks;
                logger.debug(`[Radio] Jellyfin fallback API: ${jellyfinTracks.length} tracks`);
            }
            const sliced = shuffleArray(jellyfinTracks).slice(0, limitNum);
            const transformed = sliced.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                artist: { id: t.artist.id, name: t.artist.name },
                ...(t.albumArtist && {
                    albumArtist: { id: t.albumArtist.id, name: t.albumArtist.name },
                }),
                album: {
                    id: t.album.id,
                    title: t.album.title,
                    coverArt: t.album.coverArt ?? undefined,
                },
            }));
            return res.json({ tracks: transformed });
        }

        let whereClause: any = {};
        let orderBy: any = {};
        let trackIds: string[] = [];
        let vibeSourceFeatures: any = null; // For vibe mode - store source track features

        switch (type) {
            case "discovery":
                // Lesser-played tracks - get tracks the user hasn't played or played least
                // Track has no plays relation in schema (Play.trackId can be jellyfin:xxx). Use raw query.
                const unplayedTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT t.id FROM "Track" t
                    LEFT JOIN "Play" p ON p."trackId" = t.id
                    WHERE p.id IS NULL
                    LIMIT ${limitNum * 2}
                `;

                if (unplayedTracks.length >= limitNum) {
                    trackIds = unplayedTracks.map((t) => t.id);
                } else {
                    // Fallback: get tracks with the fewest plays using raw count
                    const leastPlayedTracks = await prisma.$queryRaw<
                        { id: string }[]
                    >`
                        SELECT t.id 
                        FROM "Track" t
                        LEFT JOIN "Play" p ON p."trackId" = t.id
                        GROUP BY t.id
                        ORDER BY COUNT(p.id) ASC
                        LIMIT ${limitNum * 2}
                    `;
                    trackIds = leastPlayedTracks.map((t) => t.id);
                }
                break;

            case "favorites":
                // Most-played tracks - use raw query for accurate count ordering
                const mostPlayedTracks = await prisma.$queryRaw<
                    { id: string; play_count: bigint }[]
                >`
                    SELECT t.id, COUNT(p.id) as play_count
                    FROM "Track" t
                    LEFT JOIN "Play" p ON p."trackId" = t.id
                    GROUP BY t.id
                    HAVING COUNT(p.id) > 0
                    ORDER BY play_count DESC
                    LIMIT ${limitNum * 2}
                `;

                if (mostPlayedTracks.length > 0) {
                    trackIds = mostPlayedTracks.map((t) => t.id);
                } else {
                    // No play data yet - just get random tracks
                    logger.debug(
                        "[Radio:favorites] No play data found, returning random tracks"
                    );
                    const randomTracks = await prisma.track.findMany({
                        select: { id: true },
                        take: limitNum * 2,
                    });
                    trackIds = randomTracks.map((t) => t.id);
                }
                break;

            case "decade":
                // Filter by decade (e.g., value = "1990" for 90s)
                const decadeStart = parseInt(value as string) || 2000;

                const decadeTracks = await prisma.track.findMany({
                    where: {
                        album: getDecadeWhereClause(decadeStart),
                    },
                    select: { id: true },
                    take: limitNum * 3,
                });
                trackIds = decadeTracks.map((t) => t.id);
                break;

            case "genre":
                // Filter by genre (uses Artist.genres and Artist.userGenres)
                const genreValue = ((value as string) || "").toLowerCase();

                // Query Artist.genres and userGenres fields with raw SQL
                // Join Artist → Album → Track and filter by genre using LIKE for partial matching
                // Check BOTH canonical genres AND user-added genres (OR condition)
                const genreTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT DISTINCT t.id
                    FROM "Artist" ar
                    JOIN "Album" a ON a."artistId" = ar.id
                    JOIN "Track" t ON t."albumId" = a.id
                    WHERE (
                        (ar.genres IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
                            WHERE LOWER(g.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                        OR
                        (ar."userGenres" IS NOT NULL AND EXISTS (
                            SELECT 1 FROM jsonb_array_elements_text(ar."userGenres"::jsonb) AS ug(genre)
                            WHERE LOWER(ug.genre) LIKE ${"%" + genreValue + "%"}
                        ))
                    )
                    LIMIT ${limitNum * 2}
                `;
                trackIds = genreTracks.map((t) => t.id);

                logger.debug(
                    `[Radio:genre] Found ${trackIds.length} tracks for genre "${genreValue}" from Artist.genres and userGenres`
                );
                break;

            case "mood":
                // Mood-based filtering using audio analysis features
                const moodValue = ((value as string) || "").toLowerCase();
                let moodWhere: any = { analysisStatus: "completed" };

                switch (moodValue) {
                    case "high-energy":
                        moodWhere = {
                            analysisStatus: "completed",
                            energy: { gte: 0.7 },
                            bpm: { gte: 120 },
                        };
                        break;
                    case "chill":
                        moodWhere = {
                            analysisStatus: "completed",
                            OR: [
                                { energy: { lte: 0.4 } },
                                { arousal: { lte: 0.4 } },
                            ],
                        };
                        break;
                    case "happy":
                        moodWhere = {
                            analysisStatus: "completed",
                            valence: { gte: 0.6 },
                            energy: { gte: 0.5 },
                        };
                        break;
                    case "melancholy":
                        moodWhere = {
                            analysisStatus: "completed",
                            OR: [
                                { valence: { lte: 0.4 } },
                                { keyScale: "minor" },
                            ],
                        };
                        break;
                    case "dance":
                        moodWhere = {
                            analysisStatus: "completed",
                            danceability: { gte: 0.7 },
                        };
                        break;
                    case "acoustic":
                        moodWhere = {
                            analysisStatus: "completed",
                            acousticness: { gte: 0.6 },
                        };
                        break;
                    case "instrumental":
                        moodWhere = {
                            analysisStatus: "completed",
                            instrumentalness: { gte: 0.7 },
                        };
                        break;
                    default:
                        // Try Last.fm tags if mood not recognized
                        moodWhere = {
                            lastfmTags: { has: moodValue },
                        };
                }

                const moodTracks = await prisma.track.findMany({
                    where: moodWhere,
                    select: { id: true },
                    take: limitNum * 3,
                });
                trackIds = moodTracks.map((t) => t.id);
                break;

            case "workout":
                // High-energy workout tracks - multiple strategies
                let workoutTrackIds: string[] = [];

                // Strategy 1: Audio analysis - high energy AND fast BPM
                const energyTracks = await prisma.track.findMany({
                    where: {
                        analysisStatus: "completed",
                        OR: [
                            // High energy with fast tempo
                            {
                                AND: [
                                    { energy: { gte: 0.65 } },
                                    { bpm: { gte: 115 } },
                                ],
                            },
                            // Has workout mood tag
                            {
                                moodTags: {
                                    hasSome: ["workout", "energetic", "upbeat"],
                                },
                            },
                        ],
                    },
                    select: { id: true },
                    take: limitNum * 2,
                });
                workoutTrackIds = energyTracks.map((t) => t.id);
                logger.debug(
                    `[Radio:workout] Found ${workoutTrackIds.length} tracks via audio analysis`
                );

                // Strategy 2: Genre-based (if not enough from audio)
                if (workoutTrackIds.length < limitNum) {
                    const workoutGenreNames = [
                        "rock",
                        "metal",
                        "hard rock",
                        "alternative rock",
                        "punk",
                        "hip hop",
                        "rap",
                        "trap",
                        "electronic",
                        "edm",
                        "house",
                        "techno",
                        "drum and bass",
                        "dubstep",
                        "hardstyle",
                        "metalcore",
                        "hardcore",
                        "industrial",
                        "nu metal",
                        "pop punk",
                    ];

                    // Check Genre table
                    const workoutGenres = await prisma.genre.findMany({
                        where: {
                            name: {
                                in: workoutGenreNames,
                                mode: "insensitive",
                            },
                        },
                        include: {
                            trackGenres: {
                                select: { trackId: true },
                                take: 50,
                            },
                        },
                    });

                    const genreTrackIds = workoutGenres.flatMap((g) =>
                        g.trackGenres.map((tg) => tg.trackId)
                    );
                    workoutTrackIds = [
                        ...new Set([...workoutTrackIds, ...genreTrackIds]),
                    ];
                    logger.debug(
                        `[Radio:workout] After genre check: ${workoutTrackIds.length} tracks`
                    );

                    // Also check album.genres JSON field
                    if (workoutTrackIds.length < limitNum) {
                        const albumGenreTracks = await prisma.track.findMany({
                            where: {
                                album: {
                                    OR: workoutGenreNames.map((g) => ({
                                        genres: { string_contains: g },
                                    })),
                                },
                            },
                            select: { id: true },
                            take: limitNum,
                        });
                        workoutTrackIds = [
                            ...new Set([
                                ...workoutTrackIds,
                                ...albumGenreTracks.map((t) => t.id),
                            ]),
                        ];
                        logger.debug(
                            `[Radio:workout] After album genre check: ${workoutTrackIds.length} tracks`
                        );
                    }
                }

                trackIds = workoutTrackIds;
                break;

            case "artist":
                // Artist Radio - plays tracks from the artist + similar artists in library
                // Uses hybrid approach: Last.fm similarity (filtered to library) + genre matching + vibe boost
                const artistId = value as string;
                if (!artistId) {
                    return res
                        .status(400)
                        .json({ error: "Artist ID required for artist radio" });
                }

                logger.debug(
                    `[Radio:artist] Starting artist radio for: ${artistId}`
                );

                // 1. Get tracks from this artist (they're in library by definition)
                const artistTracks = await prisma.track.findMany({
                    where: { album: { artistId } },
                    select: {
                        id: true,
                        bpm: true,
                        energy: true,
                        valence: true,
                        danceability: true,
                    },
                });
                logger.debug(
                    `[Radio:artist] Found ${artistTracks.length} tracks from artist`
                );

                if (artistTracks.length === 0) {
                    return res.json({ tracks: [] });
                }

                // Calculate artist's average "vibe" for later matching
                const analyzedTracks = artistTracks.filter(
                    (t) => t.bpm || t.energy || t.valence
                );
                const avgVibe =
                    analyzedTracks.length > 0
                        ? {
                              bpm:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.bpm || 0),
                                      0
                                  ) / analyzedTracks.length,
                              energy:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.energy || 0),
                                      0
                                  ) / analyzedTracks.length,
                              valence:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.valence || 0),
                                      0
                                  ) / analyzedTracks.length,
                              danceability:
                                  analyzedTracks.reduce(
                                      (sum, t) => sum + (t.danceability || 0),
                                      0
                                  ) / analyzedTracks.length,
                          }
                        : null;
                logger.debug(`[Radio:artist] Artist vibe:`, avgVibe);

                // 2. Get library artist IDs (artists user actually owns)
                const libraryArtists = await prisma.album.findMany({
                    where: { tracks: { some: {} } },
                    select: { artistId: true },
                    distinct: ["artistId"],
                });
                const libraryArtistIds = new Set(
                    libraryArtists.map((r) => r.artistId)
                );
                libraryArtistIds.delete(artistId); // Exclude the current artist
                logger.debug(
                    `[Radio:artist] Library has ${libraryArtistIds.size} other artists`
                );

                // 3. Try Last.fm similar artists, filtered to library
                const similarInLibrary = await prisma.similarArtist.findMany({
                    where: {
                        fromArtistId: artistId,
                        toArtistId: { in: Array.from(libraryArtistIds) },
                    },
                    orderBy: { weight: "desc" },
                    take: 15,
                });
                let similarArtistIds = similarInLibrary.map(
                    (s) => s.toArtistId
                );
                logger.debug(
                    `[Radio:artist] Found ${similarArtistIds.length} Last.fm similar artists in library`
                );

                // 4. Fallback: genre matching if not enough similar artists
                if (similarArtistIds.length < 5 && libraryArtistIds.size > 0) {
                    const artist = await prisma.artist.findUnique({
                        where: { id: artistId },
                        select: { genres: true, userGenres: true },
                    });
                    const artistGenres = getMergedGenres(artist || {});

                    if (artistGenres.length > 0) {
                        // Find library artists with overlapping genres
                        const genreMatchArtists = await prisma.artist.findMany({
                            where: {
                                id: { in: Array.from(libraryArtistIds) },
                            },
                            select: {
                                id: true,
                                genres: true,
                                userGenres: true,
                            },
                        });

                        // Score artists by genre overlap using merged genres
                        const scoredArtists = genreMatchArtists
                            .map((a) => {
                                const theirGenres = getMergedGenres(a);
                                const overlap = artistGenres.filter((g) =>
                                    theirGenres.some(
                                        (tg) =>
                                            tg
                                                .toLowerCase()
                                                .includes(g.toLowerCase()) ||
                                            g
                                                .toLowerCase()
                                                .includes(tg.toLowerCase())
                                    )
                                ).length;
                                return { id: a.id, score: overlap };
                            })
                            .filter((a) => a.score > 0)
                            .sort((a, b) => b.score - a.score)
                            .slice(0, 10);

                        const genreArtistIds = scoredArtists.map((a) => a.id);
                        similarArtistIds = [
                            ...new Set([
                                ...similarArtistIds,
                                ...genreArtistIds,
                            ]),
                        ];
                        logger.debug(
                            `[Radio:artist] After genre matching: ${similarArtistIds.length} similar artists`
                        );
                    }
                }

                // 5. Get tracks from similar library artists
                let similarTracks: {
                    id: string;
                    bpm: number | null;
                    energy: number | null;
                    valence: number | null;
                    danceability: number | null;
                }[] = [];
                if (similarArtistIds.length > 0) {
                    similarTracks = await prisma.track.findMany({
                        where: {
                            album: { artistId: { in: similarArtistIds } },
                        },
                        select: {
                            id: true,
                            bpm: true,
                            energy: true,
                            valence: true,
                            danceability: true,
                        },
                    });
                    logger.debug(
                        `[Radio:artist] Found ${similarTracks.length} tracks from similar artists`
                    );
                }

                // 6. Apply vibe boost if we have audio analysis data
                if (avgVibe && similarTracks.length > 0) {
                    // Score each similar track by how close its vibe is to the artist's average
                    similarTracks = similarTracks
                        .map((t) => {
                            if (!t.bpm && !t.energy && !t.valence)
                                return { ...t, vibeScore: 0.5 };

                            let score = 0;
                            let factors = 0;

                            if (t.bpm && avgVibe.bpm) {
                                // BPM within 20 = good match
                                const bpmDiff = Math.abs(t.bpm - avgVibe.bpm);
                                score += Math.max(0, 1 - bpmDiff / 40);
                                factors++;
                            }
                            if (t.energy !== null && avgVibe.energy) {
                                score +=
                                    1 -
                                    Math.abs((t.energy || 0) - avgVibe.energy);
                                factors++;
                            }
                            if (t.valence !== null && avgVibe.valence) {
                                score +=
                                    1 -
                                    Math.abs(
                                        (t.valence || 0) - avgVibe.valence
                                    );
                                factors++;
                            }
                            if (
                                t.danceability !== null &&
                                avgVibe.danceability
                            ) {
                                score +=
                                    1 -
                                    Math.abs(
                                        (t.danceability || 0) -
                                            avgVibe.danceability
                                    );
                                factors++;
                            }

                            return {
                                ...t,
                                vibeScore: factors > 0 ? score / factors : 0.5,
                            };
                        })
                        .sort(
                            (a, b) =>
                                (b as any).vibeScore - (a as any).vibeScore
                        );

                    logger.debug(
                        `[Radio:artist] Applied vibe boost, top score: ${(
                            similarTracks[0] as any
                        )?.vibeScore?.toFixed(2)}`
                    );
                }

                // 7. Mix: ~40% original artist, ~60% similar (vibe-boosted)
                const originalCount = Math.min(
                    Math.ceil(limitNum * 0.4),
                    artistTracks.length
                );
                const similarCount = Math.min(
                    limitNum - originalCount,
                    similarTracks.length
                );

                const selectedOriginal = shuffleArray(artistTracks).slice(
                    0,
                    originalCount
                );
                // Take top vibe-matched tracks (already sorted by vibe score), then shuffle slightly
                const selectedSimilar = shuffleArray(
                    similarTracks.slice(0, similarCount * 2)
                ).slice(0, similarCount);

                trackIds = [...selectedOriginal, ...selectedSimilar].map(
                    (t) => t.id
                );
                logger.debug(
                    `[Radio:artist] Final mix: ${selectedOriginal.length} original + ${selectedSimilar.length} similar = ${trackIds.length} tracks`
                );
                break;

            case "vibe":
                // Vibe Match - finds tracks that sound like the given track
                // Pure audio feature matching with graceful fallbacks
                const sourceTrackId = value as string;
                if (!sourceTrackId) {
                    return res
                        .status(400)
                        .json({ error: "Track ID required for vibe matching" });
                }

                logger.debug(
                    `[Radio:vibe] Starting vibe match for track: ${sourceTrackId}`
                );

                // 1. Get the source track's audio features (including Enhanced mode fields)
                const sourceTrack = (await prisma.track.findUnique({
                    where: { id: sourceTrackId },
                    include: {
                        album: {
                            select: {
                                artistId: true,
                                genres: true,
                                artist: { select: { id: true, name: true } },
                            },
                        },
                    },
                })) as any; // Cast to any to include all Track fields

                if (!sourceTrack) {
                    return res.status(404).json({ error: "Track not found" });
                }

                // Check if track has Enhanced mode analysis
                const isEnhancedAnalysis =
                    sourceTrack.analysisMode === "enhanced" ||
                    (sourceTrack.moodHappy !== null &&
                        sourceTrack.moodSad !== null);

                logger.debug(
                    `[Radio:vibe] Source: "${sourceTrack.title}" by ${sourceTrack.album.artist.name}`
                );
                logger.debug(
                    `[Radio:vibe] Analysis mode: ${
                        isEnhancedAnalysis ? "ENHANCED" : "STANDARD"
                    }`
                );
                logger.debug(
                    `[Radio:vibe] Source features: BPM=${sourceTrack.bpm}, Energy=${sourceTrack.energy}, Valence=${sourceTrack.valence}`
                );
                if (isEnhancedAnalysis) {
                    logger.debug(
                        `[Radio:vibe] ML Moods: Happy=${sourceTrack.moodHappy}, Sad=${sourceTrack.moodSad}, Relaxed=${sourceTrack.moodRelaxed}, Aggressive=${sourceTrack.moodAggressive}, Party=${sourceTrack.moodParty}, Acoustic=${sourceTrack.moodAcoustic}, Electronic=${sourceTrack.moodElectronic}`
                    );
                }

                // Store source features for frontend visualization
                vibeSourceFeatures = {
                    bpm: sourceTrack.bpm,
                    energy: sourceTrack.energy,
                    valence: sourceTrack.valence,
                    arousal: sourceTrack.arousal,
                    danceability: sourceTrack.danceability,
                    keyScale: sourceTrack.keyScale,
                    instrumentalness: sourceTrack.instrumentalness,
                    // Enhanced mode features (all 7 ML mood predictions)
                    moodHappy: sourceTrack.moodHappy,
                    moodSad: sourceTrack.moodSad,
                    moodRelaxed: sourceTrack.moodRelaxed,
                    moodAggressive: sourceTrack.moodAggressive,
                    moodParty: sourceTrack.moodParty,
                    moodAcoustic: sourceTrack.moodAcoustic,
                    moodElectronic: sourceTrack.moodElectronic,
                    analysisMode: isEnhancedAnalysis ? "enhanced" : "standard",
                };

                let vibeMatchedIds: string[] = [];
                const sourceArtistId = sourceTrack.album.artistId;

                // 2. Try audio feature matching first (if track is analyzed)
                const hasAudioData =
                    sourceTrack.bpm ||
                    sourceTrack.energy ||
                    sourceTrack.valence;

                if (hasAudioData) {
                    // Random subset of analyzed tracks (capped to avoid loading 100k+ rows and blocking event loop 30+ min)
                    const VIBE_ANALYZED_CAP = 15_000;
                    const randomAnalyzedIds = await prisma.$queryRaw<
                        { id: string }[]
                    >`
                        SELECT id FROM "Track"
                        WHERE id != ${sourceTrackId} AND "analysisStatus" = 'completed'
                        ORDER BY RANDOM()
                        LIMIT ${VIBE_ANALYZED_CAP}
                    `;
                    const ids = randomAnalyzedIds.map((r) => r.id);
                    const analyzedTracks =
                        ids.length === 0
                            ? []
                            : await prisma.track.findMany({
                                  where: { id: { in: ids } },
                                  select: {
                                      id: true,
                                      bpm: true,
                                      energy: true,
                                      valence: true,
                                      arousal: true,
                                      danceability: true,
                                      keyScale: true,
                                      moodTags: true,
                                      lastfmTags: true,
                                      essentiaGenres: true,
                                      instrumentalness: true,
                                      moodHappy: true,
                                      moodSad: true,
                                      moodRelaxed: true,
                                      moodAggressive: true,
                                      moodParty: true,
                                      moodAcoustic: true,
                                      moodElectronic: true,
                                      danceabilityMl: true,
                                      analysisMode: true,
                                  },
                              });

                    logger.debug(
                        `[Radio:vibe] Found ${analyzedTracks.length} analyzed tracks to compare`
                    );

                    if (analyzedTracks.length > 0) {
                        // === COSINE SIMILARITY SCORING ===
                        // Industry-standard approach: build feature vectors, compute cosine similarity
                        // Uses ALL 13 features for comprehensive matching

                        // Enhanced valence: mode/tonality + mood + audio features
                        const calculateEnhancedValence = (
                            track: any
                        ): number => {
                            const happy = track.moodHappy ?? 0.5;
                            const sad = track.moodSad ?? 0.5;
                            const party = (track as any).moodParty ?? 0.5;
                            const isMajor = track.keyScale === "major";
                            const isMinor = track.keyScale === "minor";
                            const modeValence = isMajor
                                ? 0.3
                                : isMinor
                                ? -0.2
                                : 0;
                            const moodValence =
                                happy * 0.35 + party * 0.25 + (1 - sad) * 0.2;
                            const audioValence =
                                (track.energy ?? 0.5) * 0.1 +
                                (track.danceabilityMl ??
                                    track.danceability ??
                                    0.5) *
                                    0.1;

                            return Math.max(
                                0,
                                Math.min(
                                    1,
                                    moodValence + modeValence + audioValence
                                )
                            );
                        };

                        // Enhanced arousal: mood + energy + tempo (avoids unreliable "electronic" mood)
                        const calculateEnhancedArousal = (
                            track: any
                        ): number => {
                            const aggressive = track.moodAggressive ?? 0.5;
                            const party = (track as any).moodParty ?? 0.5;
                            const relaxed = track.moodRelaxed ?? 0.5;
                            const acoustic = (track as any).moodAcoustic ?? 0.5;
                            const energy = track.energy ?? 0.5;
                            const bpm = track.bpm ?? 120;
                            const moodArousal = aggressive * 0.3 + party * 0.2;
                            const energyArousal = energy * 0.25;
                            const tempoArousal =
                                Math.max(0, Math.min(1, (bpm - 60) / 120)) *
                                0.15;
                            const calmReduction =
                                (1 - relaxed) * 0.05 + (1 - acoustic) * 0.05;

                            return Math.max(
                                0,
                                Math.min(
                                    1,
                                    moodArousal +
                                        energyArousal +
                                        tempoArousal +
                                        calmReduction
                                )
                            );
                        };

                        // OOD detection using Energy-based scoring
                        const detectOOD = (track: any): boolean => {
                            const coreMoods = [
                                track.moodHappy ?? 0.5,
                                track.moodSad ?? 0.5,
                                track.moodRelaxed ?? 0.5,
                                track.moodAggressive ?? 0.5,
                            ];

                            const minMood = Math.min(...coreMoods);
                            const maxMood = Math.max(...coreMoods);

                            // Enhanced OOD detection based on research
                            // Flag if all core moods are high (>0.7) with low variance, OR if all are very neutral (~0.5)
                            const allHigh =
                                minMood > 0.7 && maxMood - minMood < 0.3;
                            const allNeutral =
                                Math.abs(maxMood - 0.5) < 0.15 &&
                                Math.abs(minMood - 0.5) < 0.15;

                            return allHigh || allNeutral;
                        };

                        // Octave-aware BPM distance calculation
                        const octaveAwareBPMDistance = (
                            bpm1: number,
                            bpm2: number
                        ): number => {
                            if (!bpm1 || !bpm2) return 0;

                            // Normalize to standard octave range (77-154 BPM)
                            const normalizeToOctave = (bpm: number): number => {
                                while (bpm < 77) bpm *= 2;
                                while (bpm > 154) bpm /= 2;
                                return bpm;
                            };

                            const norm1 = normalizeToOctave(bpm1);
                            const norm2 = normalizeToOctave(bpm2);

                            // Calculate distance on logarithmic scale for harmonic equivalence
                            const logDistance = Math.abs(
                                Math.log2(norm1) - Math.log2(norm2)
                            );
                            return Math.min(logDistance, 1); // Cap at 1 for similarity calculation
                        };

                        // Helper: Build enhanced weighted feature vector from track
                        const buildFeatureVector = (track: any): number[] => {
                            // Detect OOD and apply normalization if needed
                            const isOOD = detectOOD(track);

                            // Get mood values with OOD normalization
                            const getMoodValue = (
                                value: number | null,
                                defaultValue: number
                            ): number => {
                                if (!value) return defaultValue;
                                if (!isOOD) return value;
                                // Normalize OOD predictions to spread them out (0.2-0.8 range)
                                return (
                                    0.2 +
                                    Math.max(0, Math.min(0.6, value - 0.2))
                                );
                            };

                            // Use enhanced valence/arousal calculations
                            const enhancedValence =
                                calculateEnhancedValence(track);
                            const enhancedArousal =
                                calculateEnhancedArousal(track);

                            return [
                                // ML Mood predictions (7 features) - enhanced weighting and OOD handling
                                getMoodValue(track.moodHappy, 0.5) * 1.3, // 1.3x weight for semantic features
                                getMoodValue(track.moodSad, 0.5) * 1.3,
                                getMoodValue(track.moodRelaxed, 0.5) * 1.3,
                                getMoodValue(track.moodAggressive, 0.5) * 1.3,
                                getMoodValue((track as any).moodParty, 0.5) *
                                    1.3,
                                getMoodValue((track as any).moodAcoustic, 0.5) *
                                    1.3,
                                getMoodValue(
                                    (track as any).moodElectronic,
                                    0.5
                                ) * 1.3,
                                // Audio features (5 features) - standard weight
                                track.energy ?? 0.5,
                                enhancedArousal, // Use enhanced arousal
                                track.danceabilityMl ??
                                    track.danceability ??
                                    0.5,
                                track.instrumentalness ?? 0.5,
                                // Octave-aware BPM normalized to 0-1
                                1 -
                                    octaveAwareBPMDistance(
                                        track.bpm ?? 120,
                                        120
                                    ), // Similarity to reference tempo
                                // Enhanced key mode with valence consideration
                                enhancedValence, // Use enhanced valence instead of binary key
                            ];
                        };

                        // Helper: Compute cosine similarity between two vectors
                        const cosineSimilarity = (
                            a: number[],
                            b: number[]
                        ): number => {
                            let dot = 0,
                                magA = 0,
                                magB = 0;
                            for (let i = 0; i < a.length; i++) {
                                dot += a[i] * b[i];
                                magA += a[i] * a[i];
                                magB += b[i] * b[i];
                            }
                            if (magA === 0 || magB === 0) return 0;
                            return dot / (Math.sqrt(magA) * Math.sqrt(magB));
                        };

                        // Helper: Compute tag overlap bonus
                        const computeTagBonus = (
                            sourceTags: string[],
                            sourceGenres: string[],
                            trackTags: string[],
                            trackGenres: string[]
                        ): number => {
                            const sourceSet = new Set(
                                [...sourceTags, ...sourceGenres].map((t) =>
                                    t.toLowerCase()
                                )
                            );
                            const trackSet = new Set(
                                [...trackTags, ...trackGenres].map((t) =>
                                    t.toLowerCase()
                                )
                            );
                            if (sourceSet.size === 0 || trackSet.size === 0)
                                return 0;
                            const overlap = [...sourceSet].filter((tag) =>
                                trackSet.has(tag)
                            ).length;
                            // Max 5% bonus for tag overlap
                            return Math.min(0.05, overlap * 0.01);
                        };

                        // Build source feature vector once
                        const sourceVector = buildFeatureVector(sourceTrack);

                        // Check if source track has Enhanced mode data
                        const bothEnhanced = isEnhancedAnalysis;

                        const scored = analyzedTracks.map((t) => {
                            // Check if target track has Enhanced mode data
                            const targetEnhanced =
                                t.analysisMode === "enhanced" ||
                                (t.moodHappy !== null && t.moodSad !== null);
                            const useEnhanced = bothEnhanced && targetEnhanced;

                            // Build target feature vector
                            const targetVector = buildFeatureVector(t as any);

                            // Compute base cosine similarity
                            let score = cosineSimilarity(
                                sourceVector,
                                targetVector
                            );

                            // Add tag/genre overlap bonus (max 5%)
                            const tagBonus = computeTagBonus(
                                sourceTrack.lastfmTags || [],
                                sourceTrack.essentiaGenres || [],
                                t.lastfmTags || [],
                                t.essentiaGenres || []
                            );

                            // Final score: 95% cosine similarity + 5% tag bonus
                            const finalScore = score * 0.95 + tagBonus;

                            return {
                                id: t.id,
                                score: finalScore,
                                enhanced: useEnhanced,
                            };
                        });

                        // Filter to good matches and sort by score
                        // Use lower threshold (40%) for Enhanced mode since it's more precise
                        const minThreshold = isEnhancedAnalysis ? 0.4 : 0.5;
                        const goodMatches = scored
                            .filter((t) => t.score > minThreshold)
                            .sort((a, b) => b.score - a.score);

                        vibeMatchedIds = goodMatches.map((t) => t.id);
                        const enhancedCount = goodMatches.filter(
                            (t) => t.enhanced
                        ).length;
                        logger.debug(
                            `[Radio:vibe] Audio matching found ${
                                vibeMatchedIds.length
                            } tracks (>${minThreshold * 100}% similarity)`
                        );
                        logger.debug(
                            `[Radio:vibe] Enhanced matches: ${enhancedCount}, Standard matches: ${
                                goodMatches.length - enhancedCount
                            }`
                        );

                        if (goodMatches.length > 0) {
                            logger.debug(
                                `[Radio:vibe] Top match score: ${goodMatches[0].score.toFixed(
                                    2
                                )} (${
                                    goodMatches[0].enhanced
                                        ? "enhanced"
                                        : "standard"
                                })`
                            );
                        }
                    }
                }

                // 3. Fallback A: Same artist's other tracks
                if (vibeMatchedIds.length < limitNum) {
                    const artistTracks = await prisma.track.findMany({
                        where: {
                            album: { artistId: sourceArtistId },
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                    });
                    const newIds = artistTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback A (same artist): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                // 4. Fallback B: Similar artists from Last.fm (filtered to library)
                if (vibeMatchedIds.length < limitNum) {
                    const ownedArtistIds = await prisma.album.findMany({
                        where: { tracks: { some: {} } },
                        select: { artistId: true },
                        distinct: ["artistId"],
                    });
                    const libraryArtistSet = new Set(
                        ownedArtistIds.map((r) => r.artistId)
                    );
                    libraryArtistSet.delete(sourceArtistId);

                    const similarArtists = await prisma.similarArtist.findMany({
                        where: {
                            fromArtistId: sourceArtistId,
                            toArtistId: { in: Array.from(libraryArtistSet) },
                        },
                        orderBy: { weight: "desc" },
                        take: 10,
                    });

                    if (similarArtists.length > 0) {
                        const similarArtistTracks = await prisma.track.findMany(
                            {
                                where: {
                                    album: {
                                        artistId: {
                                            in: similarArtists.map(
                                                (s) => s.toArtistId
                                            ),
                                        },
                                    },
                                    id: {
                                        notIn: [
                                            sourceTrackId,
                                            ...vibeMatchedIds,
                                        ],
                                    },
                                },
                                select: { id: true },
                            }
                        );
                        const newIds = similarArtistTracks.map((t) => t.id);
                        vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                        logger.debug(
                            `[Radio:vibe] Fallback B (similar artists): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                        );
                    }
                }

                // 5. Fallback C: Same genre (using TrackGenre relation)
                const sourceGenres =
                    (sourceTrack.album.genres as string[]) || [];
                if (
                    vibeMatchedIds.length < limitNum &&
                    sourceGenres.length > 0
                ) {
                    // Search using the TrackGenre relation for better accuracy
                    const genreTracks = await prisma.track.findMany({
                        where: {
                            trackGenres: {
                                some: {
                                    genre: {
                                        name: {
                                            in: sourceGenres,
                                            mode: "insensitive",
                                        },
                                    },
                                },
                            },
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                        take: limitNum,
                    });
                    const newIds = genreTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback C (same genre): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                // 6. Fallback D: Random from library
                if (vibeMatchedIds.length < limitNum) {
                    const randomTracks = await prisma.track.findMany({
                        where: {
                            id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                        },
                        select: { id: true },
                        take: limitNum - vibeMatchedIds.length,
                    });
                    const newIds = randomTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback D (random): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`
                    );
                }

                trackIds = vibeMatchedIds;
                logger.debug(
                    `[Radio:vibe] Final vibe queue: ${trackIds.length} tracks`
                );
                break;

            case "all":
            default: {
                // Random selection from library via DB (never load all IDs - was blocking event loop 30+ min on large libraries)
                const randomIds = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT id FROM "Track"
                    ORDER BY RANDOM()
                    LIMIT ${limitNum}
                `;
                trackIds = randomIds.map((r) => r.id);
                break;
            }
        }

        // For vibe mode, keep the sorted order (by match score)
        // For other modes, shuffle the results
        const finalIds =
            type === "vibe"
                ? trackIds.slice(0, limitNum) // Already sorted by match score
                : shuffleArray(trackIds).slice(0, limitNum);

        if (finalIds.length === 0) {
            return res.json({ tracks: [] });
        }

        // Fetch full track data (include all analysis fields for logging)
        const tracks = await prisma.track.findMany({
            where: {
                id: { in: finalIds },
            },
            include: {
                album: {
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
                trackGenres: {
                    include: {
                        genre: { select: { name: true } },
                    },
                },
            },
        });

        // For vibe mode, reorder tracks to match the sorted finalIds order
        // (Prisma's findMany with IN doesn't preserve order)
        let orderedTracks = tracks;
        if (type === "vibe") {
            const trackMap = new Map(tracks.map((t) => [t.id, t]));
            orderedTracks = finalIds
                .map((id) => trackMap.get(id))
                .filter((t): t is (typeof tracks)[0] => t !== undefined);
        }

        // === VIBE QUEUE LOGGING ===
        // Log detailed info for vibe matching analysis (using ordered tracks)
        if (type === "vibe" && vibeSourceFeatures) {
            logger.debug("\n" + "=".repeat(100));
            logger.debug("VIBE QUEUE ANALYSIS - Source Track");
            logger.debug("=".repeat(100));

            // Find source track for logging
            const srcTrack = await prisma.track.findUnique({
                where: { id: value as string },
                include: {
                    album: { include: { artist: { select: { name: true } } } },
                    trackGenres: {
                        include: { genre: { select: { name: true } } },
                    },
                },
            });

            if (srcTrack) {
                logger.debug(
                    `SOURCE: "${srcTrack.title}" by ${srcTrack.album.artist.name}`
                );
                logger.debug(`  Album: ${srcTrack.album.title}`);
                logger.debug(
                    `  Analysis Mode: ${
                        (srcTrack as any).analysisMode || "unknown"
                    }`
                );
                logger.debug(
                    `  BPM: ${srcTrack.bpm?.toFixed(1) || "N/A"} | Energy: ${
                        srcTrack.energy?.toFixed(2) || "N/A"
                    } | Valence: ${srcTrack.valence?.toFixed(2) || "N/A"}`
                );
                logger.debug(
                    `  Danceability: ${
                        srcTrack.danceability?.toFixed(2) || "N/A"
                    } | Arousal: ${
                        srcTrack.arousal?.toFixed(2) || "N/A"
                    } | Key: ${srcTrack.keyScale || "N/A"}`
                );
                logger.debug(
                    `  ML Moods: Happy=${
                        (srcTrack as any).moodHappy?.toFixed(2) || "N/A"
                    }, Sad=${
                        (srcTrack as any).moodSad?.toFixed(2) || "N/A"
                    }, Relaxed=${
                        (srcTrack as any).moodRelaxed?.toFixed(2) || "N/A"
                    }, Aggressive=${
                        (srcTrack as any).moodAggressive?.toFixed(2) || "N/A"
                    }`
                );
                logger.debug(
                    `  Genres: ${
                        srcTrack.trackGenres
                            .map((tg) => tg.genre.name)
                            .join(", ") || "N/A"
                    }`
                );
                logger.debug(
                    `  Last.fm Tags: ${
                        ((srcTrack as any).lastfmTags || []).join(", ") || "N/A"
                    }`
                );
                logger.debug(
                    `  Mood Tags: ${
                        ((srcTrack as any).moodTags || []).join(", ") || "N/A"
                    }`
                );
            }

            logger.debug("\n" + "-".repeat(100));
            logger.debug(
                `VIBE QUEUE - ${orderedTracks.length} tracks (showing up to 50, SORTED BY MATCH SCORE)`
            );
            logger.debug("-".repeat(100));
            logger.debug(
                `${"#".padEnd(3)} | ${"TRACK".padEnd(35)} | ${"ARTIST".padEnd(
                    20
                )} | ${"BPM".padEnd(6)} | ${"ENG".padEnd(5)} | ${"VAL".padEnd(
                    5
                )} | ${"H".padEnd(4)} | ${"S".padEnd(4)} | ${"R".padEnd(
                    4
                )} | ${"A".padEnd(4)} | MODE    | GENRES`
            );
            logger.debug("-".repeat(100));

            orderedTracks.slice(0, 50).forEach((track, i) => {
                const t = track as any;
                const title = track.title.substring(0, 33).padEnd(35);
                const artist = track.album.artist.name
                    .substring(0, 18)
                    .padEnd(20);
                const bpm = track.bpm
                    ? track.bpm.toFixed(0).padEnd(6)
                    : "N/A".padEnd(6);
                const energy =
                    track.energy !== null
                        ? track.energy.toFixed(2).padEnd(5)
                        : "N/A".padEnd(5);
                const valence =
                    track.valence !== null
                        ? track.valence.toFixed(2).padEnd(5)
                        : "N/A".padEnd(5);
                const happy =
                    t.moodHappy !== null
                        ? t.moodHappy.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const sad =
                    t.moodSad !== null
                        ? t.moodSad.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const relaxed =
                    t.moodRelaxed !== null
                        ? t.moodRelaxed.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const aggressive =
                    t.moodAggressive !== null
                        ? t.moodAggressive.toFixed(2).padEnd(4)
                        : "N/A".padEnd(4);
                const mode = (t.analysisMode || "std")
                    .substring(0, 7)
                    .padEnd(8);
                const genres = track.trackGenres
                    .slice(0, 3)
                    .map((tg) => tg.genre.name)
                    .join(", ");

                logger.debug(
                    `${String(i + 1).padEnd(
                        3
                    )} | ${title} | ${artist} | ${bpm} | ${energy} | ${valence} | ${happy} | ${sad} | ${relaxed} | ${aggressive} | ${mode} | ${genres}`
                );
            });

            if (orderedTracks.length > 50) {
                logger.debug(
                    `... and ${orderedTracks.length - 50} more tracks`
                );
            }

            logger.debug("=".repeat(100) + "\n");
        }

        // Transform to match frontend Track interface
        const transformedTracks = orderedTracks.map((track) => ({
            id: track.id,
            title: track.title,
            duration: track.duration,
            trackNo: track.trackNo,
            filePath: track.filePath,
            artist: {
                id: track.album.artist.id,
                name: track.album.artist.name,
            },
            album: {
                id: track.album.id,
                title: track.album.title,
                coverArt: track.album.coverUrl,
            },
            // Include audio features for vibe mode visualization (if available)
            ...(vibeSourceFeatures && {
                audioFeatures: {
                    bpm: track.bpm,
                    energy: track.energy,
                    valence: track.valence,
                    arousal: track.arousal,
                    danceability: track.danceability,
                    keyScale: track.keyScale,
                    instrumentalness: track.instrumentalness,
                    analysisMode: track.analysisMode,
                    // ML Mood predictions for enhanced visualization
                    moodHappy: track.moodHappy,
                    moodSad: track.moodSad,
                    moodRelaxed: track.moodRelaxed,
                    moodAggressive: track.moodAggressive,
                    moodParty: track.moodParty,
                    moodAcoustic: track.moodAcoustic,
                    moodElectronic: track.moodElectronic,
                },
            }),
        }));

        // For vibe mode, keep sorted order. For other modes, shuffle.
        const finalTracks =
            type === "vibe" ? transformedTracks : shuffleArray(transformedTracks);

        // Include source features if this was a vibe request
        const response: any = { tracks: finalTracks };
        if (vibeSourceFeatures) {
            response.sourceFeatures = vibeSourceFeatures;
        }

        res.json(response);
    } catch (error) {
        logger.error("Radio endpoint error:", error);
        res.status(500).json({ error: "Failed to get radio tracks" });
    }
});

export default router;
