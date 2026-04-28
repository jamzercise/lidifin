import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";

const router = Router();

// All routes require auth (session or API key)
router.use(requireAuthOrToken);

/**
 * GET /homepage/genres
 * Get top genres from user's library with sample albums
 */
router.get("/genres", async (req, res) => {
    try {
        const { limit = "4" } = req.query;
        const limitNum = parseInt(limit as string, 10);

        // Check Redis cache first (cache for 24 hours).
        // The genres breakdown is computed across the *library* (Album rows), not
        // per-user, so the cache key intentionally does NOT include userId — every
        // user gets the same answer, and we don't want N copies of an identical
        // payload sitting in Redis.
        const cacheKey = `homepage:genres:${limitNum}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[HOMEPAGE] Cache HIT for genres`);
                return res.json(JSON.parse(cached));
            }
        } catch (cacheError) {
            logger.warn("[HOMEPAGE] Redis cache read error:", cacheError);
        }

        logger.debug(
            `[HOMEPAGE] ✗ Cache MISS for genres, fetching from database...`
        );

        // Compute the top-N genres and their sample albums in a single SQL
        // round-trip. The previous implementation pulled up to 8,000 album
        // rows + artist join into Node, then ran the aggregation in JS — that
        // shipped an entire library's worth of JSONB across the wire on every
        // cache miss and pinned the data in the JS heap until GC.
        //
        // Now: PG explodes Album.genres (JSONB array) with
        // jsonb_array_elements_text into one row per (album, genre), counts
        // occurrences per genre, takes the top N, then ranks albums within
        // each top genre and keeps only the first 10. Final result set is
        // bounded at limit × 10 rows regardless of library size.
        //
        // The per-genre album ordering (year DESC NULLS LAST) intentionally
        // matches the previous behavior's bias toward recent releases.
        const SAMPLES_PER_GENRE = 10;
        const rows = await prisma.$queryRaw<
            {
                genre: string;
                total_count: bigint;
                album_id: string;
                title: string;
                year: number | null;
                cover_url: string | null;
                artist_id: string;
                artist_name: string;
            }[]
        >`
            WITH expanded AS (
                SELECT
                    g.genre,
                    a.id            AS album_id,
                    a.title         AS title,
                    a.year          AS year,
                    a."coverUrl"    AS cover_url,
                    ar.id           AS artist_id,
                    ar.name         AS artist_name
                FROM "Album" a
                JOIN "Artist" ar ON a."artistId" = ar.id
                CROSS JOIN LATERAL jsonb_array_elements_text(a.genres) AS g(genre)
                WHERE a.location = 'LIBRARY'
                  AND a.genres IS NOT NULL
                  AND jsonb_typeof(a.genres) = 'array'
            ),
            counts AS (
                SELECT genre, COUNT(*)::bigint AS total_count
                FROM expanded
                GROUP BY genre
                ORDER BY total_count DESC
                LIMIT ${limitNum}
            ),
            ranked AS (
                SELECT
                    e.genre,
                    e.album_id,
                    e.title,
                    e.year,
                    e.cover_url,
                    e.artist_id,
                    e.artist_name,
                    c.total_count,
                    ROW_NUMBER() OVER (
                        PARTITION BY e.genre
                        ORDER BY e.year DESC NULLS LAST, e.album_id
                    ) AS rn
                FROM expanded e
                JOIN counts c ON e.genre = c.genre
            )
            SELECT genre, total_count, album_id, title, year, cover_url, artist_id, artist_name
            FROM ranked
            WHERE rn <= ${SAMPLES_PER_GENRE}
            ORDER BY total_count DESC, genre, year DESC NULLS LAST, album_id
        `;

        // Group the flat rows back into the response shape. We rely on
        // counts CTE having ordered genres by total_count DESC, so the first
        // time we see a given genre fixes its position.
        const genreOrder: string[] = [];
        const buckets = new Map<
            string,
            {
                genre: string;
                albums: {
                    id: string;
                    title: string;
                    year: number | null;
                    coverArt: string | null;
                    artist: { id: string; name: string };
                }[];
                totalCount: number;
            }
        >();

        for (const r of rows) {
            let bucket = buckets.get(r.genre);
            if (!bucket) {
                bucket = {
                    genre: r.genre,
                    albums: [],
                    totalCount: Number(r.total_count),
                };
                buckets.set(r.genre, bucket);
                genreOrder.push(r.genre);
            }
            bucket.albums.push({
                id: r.album_id,
                title: r.title,
                year: r.year,
                coverArt: r.cover_url,
                artist: { id: r.artist_id, name: r.artist_name },
            });
        }

        const genresWithAlbums = genreOrder.map((g) => buckets.get(g)!);

        logger.debug(
            `[HOMEPAGE] Top genres: ${genreOrder.join(", ")}`
        );

        // Cache for 24 hours
        try {
            await redisClient.setEx(
                cacheKey,
                24 * 60 * 60,
                JSON.stringify(genresWithAlbums)
            );
            logger.debug(`[HOMEPAGE] Cached genres for 24 hours`);
        } catch (cacheError) {
            logger.warn("[HOMEPAGE] Redis cache write error:", cacheError);
        }

        res.json(genresWithAlbums);
    } catch (error) {
        logger.error("Get homepage genres error:", error);
        res.status(500).json({ error: "Failed to fetch genres" });
    }
});

/**
 * GET /homepage/top-podcasts
 * Get top podcasts (most subscribed or most recent episodes)
 */
router.get("/top-podcasts", async (req, res) => {
    try {
        const { limit = "6" } = req.query;
        const limitNum = parseInt(limit as string, 10);

        // Check Redis cache first (cache for 24 hours).
        // Like /genres, this is library-wide data — orders Podcast rows by
        // createdAt — not per-user, so we drop userId from the cache key.
        const cacheKey = `homepage:top-podcasts:${limitNum}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[HOMEPAGE] Cache HIT for top podcasts`);
                return res.json(JSON.parse(cached));
            }
        } catch (cacheError) {
            logger.warn("[HOMEPAGE] Redis cache read error:", cacheError);
        }

        logger.debug(
            `[HOMEPAGE] ✗ Cache MISS for top podcasts, fetching from database...`
        );

        // Get podcasts with episode counts
        const podcasts = await prisma.podcast.findMany({
            take: limitNum,
            orderBy: { createdAt: "desc" }, // Most recently added
            select: {
                id: true,
                title: true,
                author: true,
                description: true,
                imageUrl: true,
                _count: {
                    select: { episodes: true },
                },
            },
        });

        const result = podcasts.map((podcast) => ({
            id: podcast.id,
            title: podcast.title,
            author: podcast.author,
            description: podcast.description?.substring(0, 150) + "...",
            coverArt: podcast.imageUrl,
            episodeCount: podcast._count.episodes,
        }));

        // Cache for 24 hours
        try {
            await redisClient.setEx(
                cacheKey,
                24 * 60 * 60,
                JSON.stringify(result)
            );
            logger.debug(`[HOMEPAGE] Cached top podcasts for 24 hours`);
        } catch (cacheError) {
            logger.warn("[HOMEPAGE] Redis cache write error:", cacheError);
        }

        res.json(result);
    } catch (error) {
        logger.error("Get top podcasts error:", error);
        res.status(500).json({ error: "Failed to fetch top podcasts" });
    }
});

export default router;
