import type { Router } from "express";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";

/** Similar podcasts + cached cover images (podcast and episode). */
export function registerPodcastRecommendationsAndCoversRoutes(
    router: Router,
): void {
    /**
     * GET /podcasts/:id/similar
     * Get similar podcasts using iTunes Search API (free, no auth required)
     */
    router.get("/:id/similar", async (req, res) => {
        try {
            const { id } = req.params;

            const podcast = await prisma.podcast.findUnique({
                where: { id },
            });

            if (!podcast) {
                return res.status(404).json({ error: "Podcast not found" });
            }

            logger.debug(`\n [SIMILAR PODCASTS] Request for: ${podcast.title}`);

            try {
                // Check cache first
                const cachedRecommendations =
                    await prisma.podcastRecommendation.findMany({
                        where: {
                            podcastId: id,
                            expiresAt: { gt: new Date() },
                        },
                        orderBy: { score: "desc" },
                        take: 10,
                    });

                if (cachedRecommendations.length > 0) {
                    logger.debug(
                        `   Using ${cachedRecommendations.length} cached recommendations`,
                    );
                    return res.json(
                        cachedRecommendations.map((rec) => ({
                            id: rec.recommendedId,
                            title: rec.title,
                            author: rec.author,
                            description: rec.description,
                            coverUrl: rec.coverUrl,
                            episodeCount: rec.episodeCount,
                            feedUrl: rec.feedUrl,
                            itunesId: rec.itunesId,
                            isExternal: true,
                            score: rec.score,
                        })),
                    );
                }

                // Fetch from iTunes Search API
                logger.debug(`    Fetching from iTunes Search API...`);
                const { itunesService } = await import("../../services/itunes");
                const recommendations = await itunesService.getSimilarPodcasts(
                    podcast.title,
                    podcast.description ?? undefined,
                    podcast.author ?? undefined,
                );

                logger.debug(
                    `   Found ${recommendations.length} similar podcasts`,
                );

                if (recommendations.length > 0) {
                    // Cache recommendations
                    const expiresAt = new Date();
                    expiresAt.setDate(expiresAt.getDate() + 30); // 30 days cache

                    await prisma.podcastRecommendation.deleteMany({
                        where: { podcastId: id },
                    });

                    await prisma.podcastRecommendation.createMany({
                        data: recommendations.map((rec, index) => ({
                            podcastId: id,
                            recommendedId: rec.collectionId.toString(),
                            title: rec.collectionName,
                            author: rec.artistName,
                            description: "",
                            coverUrl: rec.artworkUrl600 || rec.artworkUrl100,
                            episodeCount: rec.trackCount || 0,
                            feedUrl: rec.feedUrl,
                            itunesId: rec.collectionId.toString(),
                            score: recommendations.length - index,
                            cachedAt: new Date(),
                            expiresAt,
                        })),
                    });

                    logger.debug(
                        `   Cached ${recommendations.length} recommendations`,
                    );

                    return res.json(
                        recommendations.map((rec, index) => ({
                            id: rec.collectionId.toString(),
                            title: rec.collectionName,
                            author: rec.artistName,
                            description: "",
                            coverUrl: rec.artworkUrl600 || rec.artworkUrl100,
                            episodeCount: rec.trackCount || 0,
                            feedUrl: rec.feedUrl,
                            itunesId: rec.collectionId,
                            isExternal: true,
                            score: recommendations.length - index,
                        })),
                    );
                }
            } catch (error: any) {
                logger.warn("    iTunes search failed:", error.message);
            }

            // No recommendations available
            logger.debug(`    No recommendations found`);
            res.json([]);
        } catch (error: any) {
            logger.error("Error fetching similar podcasts:", error);
            res.status(500).json({
                error: "Failed to fetch similar podcasts",
                message: error.message,
            });
        }
    });

    /**
     * OPTIONS /podcasts/:id/cover
     * Handle CORS preflight request for podcast cover images
     */
    router.options("/:id/cover", (req, res) => {
        const origin = req.headers.origin || "*";
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
        res.status(204).end();
    });

    /**
     * GET /podcasts/:id/cover
     * Serve cached podcast cover from local disk
     */
    router.get("/:id/cover", async (req, res) => {
        try {
            const { id } = req.params;

            const podcast = await prisma.podcast.findUnique({
                where: { id },
                select: { localCoverPath: true, imageUrl: true },
            });

            if (!podcast) {
                return res.status(404).json({ error: "Podcast not found" });
            }

            // Serve from local disk if cached
            if (podcast.localCoverPath) {
                res.setHeader(
                    "Cache-Control",
                    "public, max-age=31536000, immutable",
                );
                res.setHeader(
                    "Access-Control-Allow-Origin",
                    req.headers.origin || "*",
                );
                res.setHeader("Access-Control-Allow-Credentials", "true");
                res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
                return res.sendFile(podcast.localCoverPath);
            }

            // Fallback: redirect to original URL
            if (podcast.imageUrl) {
                return res.redirect(podcast.imageUrl);
            }

            res.status(404).json({ error: "Cover not found" });
        } catch (error: any) {
            logger.error("Error serving podcast cover:", error);
            res.status(500).json({
                error: "Failed to serve cover",
                message: error.message,
            });
        }
    });

    /**
     * OPTIONS /podcasts/episodes/:episodeId/cover
     * Handle CORS preflight request for episode cover images
     */
    router.options("/episodes/:episodeId/cover", (req, res) => {
        const origin = req.headers.origin || "*";
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours
        res.status(204).end();
    });

    /**
     * GET /podcasts/episodes/:episodeId/cover
     * Serve cached episode cover from local disk
     */
    router.get("/episodes/:episodeId/cover", async (req, res) => {
        try {
            const { episodeId } = req.params;

            const episode = await prisma.podcastEpisode.findUnique({
                where: { id: episodeId },
                select: { localCoverPath: true, imageUrl: true },
            });

            if (!episode) {
                return res.status(404).json({ error: "Episode not found" });
            }

            // Serve from local disk if cached
            if (episode.localCoverPath) {
                res.setHeader(
                    "Cache-Control",
                    "public, max-age=31536000, immutable",
                );
                res.setHeader(
                    "Access-Control-Allow-Origin",
                    req.headers.origin || "*",
                );
                res.setHeader("Access-Control-Allow-Credentials", "true");
                res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
                return res.sendFile(episode.localCoverPath);
            }

            // Fallback: redirect to original URL
            if (episode.imageUrl) {
                return res.redirect(episode.imageUrl);
            }

            res.status(404).json({ error: "Cover not found" });
        } catch (error: any) {
            logger.error("Error serving episode cover:", error);
            res.status(500).json({
                error: "Failed to serve cover",
                message: error.message,
            });
        }
    });
}
