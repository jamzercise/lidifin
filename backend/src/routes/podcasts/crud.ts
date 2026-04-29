import type { Router } from "express";
import axios from "axios";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { rssParserService } from "../../services/rss-parser";
import { refreshPodcastFeed } from "../../services/podcastFeedRefresh";

/** Subscribed podcast detail, subscribe/unsubscribe, and feed refresh. */
export function registerPodcastCrudRoutes(router: Router): void {
    router.get("/:id", async (req, res) => {
        try {
            const { id } = req.params;

            // Check if user is subscribed
            const subscription = await prisma.podcastSubscription.findUnique({
                where: {
                    userId_podcastId: {
                        userId: req.user!.id,
                        podcastId: id,
                    },
                },
            });

            if (!subscription) {
                return res
                    .status(404)
                    .json({ error: "Podcast not found or not subscribed" });
            }

            const podcast = await prisma.podcast.findUnique({
                where: { id },
                include: {
                    episodes: {
                        orderBy: { publishedAt: "desc" },
                        include: {
                            progress: {
                                where: { userId: req.user!.id },
                            },
                            downloads: {
                                where: { userId: req.user!.id },
                            },
                        },
                    },
                },
            });

            if (!podcast) {
                return res.status(404).json({ error: "Podcast not found" });
            }

            const episodesWithProgress = podcast.episodes.map((episode) => ({
                id: episode.id,
                title: episode.title,
                description: episode.description,
                duration: episode.duration,
                publishedAt: episode.publishedAt,
                episodeNumber: episode.episodeNumber,
                season: episode.season,
                imageUrl: episode.imageUrl,
                isDownloaded: episode.downloads.length > 0,
                progress: episode.progress[0]
                    ? {
                          currentTime: episode.progress[0].currentTime,
                          progress:
                              episode.progress[0].duration > 0
                                  ? (episode.progress[0].currentTime /
                                        episode.progress[0].duration) *
                                    100
                                  : 0,
                          isFinished: episode.progress[0].isFinished,
                          lastPlayedAt: episode.progress[0].lastPlayedAt,
                      }
                    : null,
            }));

            res.json({
                id: podcast.id,
                title: podcast.title,
                author: podcast.author,
                description: podcast.description,
                coverUrl: podcast.imageUrl,
                feedUrl: podcast.feedUrl,
                genres: [], // Podcast genres not yet stored in database
                autoDownloadEpisodes: false,
                episodes: episodesWithProgress,
                isSubscribed: true,
            });
        } catch (error: any) {
            logger.error("Error fetching podcast:", error);
            res.status(500).json({
                error: "Failed to fetch podcast",
                message: error.message,
            });
        }
    });
    router.post("/subscribe", async (req, res) => {
        try {
            const { feedUrl, itunesId } = req.body;

            if (!feedUrl && !itunesId) {
                return res
                    .status(400)
                    .json({ error: "feedUrl or itunesId is required" });
            }

            logger.debug(
                `\n [PODCAST] Subscribe request from ${req.user!.username}`,
            );
            logger.debug(`   Feed URL: ${feedUrl || "N/A"}`);
            logger.debug(`   iTunes ID: ${itunesId || "N/A"}`);

            let finalFeedUrl = feedUrl;

            // If only iTunes ID provided, fetch feed URL from iTunes API
            if (!finalFeedUrl && itunesId) {
                logger.debug(`    Looking up feed URL from iTunes...`);
                const itunesResponse = await axios.get(
                    "https://itunes.apple.com/lookup",
                    {
                        params: { id: itunesId, entity: "podcast" },
                    },
                );

                if (
                    itunesResponse.data.resultCount === 0 ||
                    !itunesResponse.data.results[0].feedUrl
                ) {
                    return res
                        .status(404)
                        .json({ error: "Podcast not found in iTunes" });
                }

                finalFeedUrl = itunesResponse.data.results[0].feedUrl;
                logger.debug(`   Found feed URL: ${finalFeedUrl}`);
            }

            // Check if podcast already exists in database
            let podcast = await prisma.podcast.findUnique({
                where: { feedUrl: finalFeedUrl },
            });

            if (podcast) {
                logger.debug(`   Podcast exists in database: ${podcast.title}`);

                // Check if user is already subscribed
                const existingSubscription =
                    await prisma.podcastSubscription.findUnique({
                        where: {
                            userId_podcastId: {
                                userId: req.user!.id,
                                podcastId: podcast.id,
                            },
                        },
                    });

                if (existingSubscription) {
                    logger.debug(`     User already subscribed`);
                    return res.json({
                        success: true,
                        podcast: {
                            id: podcast.id,
                            title: podcast.title,
                        },
                        message: "Already subscribed",
                    });
                }

                // Subscribe user to existing podcast
                await prisma.podcastSubscription.create({
                    data: {
                        userId: req.user!.id,
                        podcastId: podcast.id,
                    },
                });

                logger.debug(`   User subscribed to existing podcast`);
                return res.json({
                    success: true,
                    podcast: {
                        id: podcast.id,
                        title: podcast.title,
                    },
                    message: "Subscribed successfully",
                });
            }

            // Parse RSS feed to get podcast and episodes
            logger.debug(`   Parsing RSS feed...`);
            const { podcast: podcastData, episodes } =
                await rssParserService.parseFeed(finalFeedUrl);

            // Create podcast in database
            logger.debug(`    Saving podcast to database...`);
            const finalItunesId = itunesId || podcastData.itunesId;
            logger.debug(`   iTunes ID to save: ${finalItunesId || "NONE"}`);

            podcast = await prisma.podcast.create({
                data: {
                    feedUrl: finalFeedUrl,
                    title: podcastData.title,
                    author: podcastData.author,
                    description: podcastData.description,
                    imageUrl: podcastData.imageUrl,
                    itunesId: finalItunesId,
                    language: podcastData.language,
                    explicit: podcastData.explicit || false,
                    episodeCount: episodes.length,
                },
            });

            logger.debug(`   Podcast created: ${podcast.id}`);
            logger.debug(`   iTunes ID saved: ${podcast.itunesId || "NONE"}`);

            // Save episodes
            logger.debug(`    Saving ${episodes.length} episodes...`);
            await prisma.podcastEpisode.createMany({
                data: episodes.map((ep) => ({
                    podcastId: podcast!.id,
                    guid: ep.guid,
                    title: ep.title,
                    description: ep.description,
                    audioUrl: ep.audioUrl,
                    duration: ep.duration,
                    publishedAt: ep.publishedAt,
                    episodeNumber: ep.episodeNumber,
                    season: ep.season,
                    imageUrl: ep.imageUrl,
                    fileSize: ep.fileSize,
                    mimeType: ep.mimeType,
                })),
                skipDuplicates: true,
            });

            logger.debug(`   Episodes saved`);

            // Subscribe user
            await prisma.podcastSubscription.create({
                data: {
                    userId: req.user!.id,
                    podcastId: podcast.id,
                },
            });

            logger.debug(`   User subscribed successfully`);

            res.json({
                success: true,
                podcast: {
                    id: podcast.id,
                    title: podcast.title,
                },
                message: "Subscribed successfully",
            });
        } catch (error: any) {
            logger.error("Error subscribing to podcast:", error);
            res.status(500).json({
                error: "Failed to subscribe to podcast",
                message: error.message,
            });
        }
    });

    /**
     * DELETE /podcasts/:id/unsubscribe
     * Unsubscribe from a podcast
     */
    router.delete("/:id/unsubscribe", async (req, res) => {
        try {
            const { id } = req.params;

            logger.debug(`\n[PODCAST] Unsubscribe request`);
            logger.debug(`   User: ${req.user!.username}`);
            logger.debug(`   Podcast ID: ${id}`);

            // Delete subscription
            const deleted = await prisma.podcastSubscription.deleteMany({
                where: {
                    userId: req.user!.id,
                    podcastId: id,
                },
            });

            if (deleted.count === 0) {
                return res
                    .status(404)
                    .json({ error: "Not subscribed to this podcast" });
            }

            // Also delete user's progress for this podcast
            await prisma.podcastProgress.deleteMany({
                where: {
                    userId: req.user!.id,
                    episode: {
                        podcastId: id,
                    },
                },
            });

            // Also delete any downloaded episodes
            await prisma.podcastDownload.deleteMany({
                where: {
                    userId: req.user!.id,
                    episode: {
                        podcastId: id,
                    },
                },
            });

            logger.debug(`   Unsubscribed successfully`);

            res.json({
                success: true,
                message: "Unsubscribed successfully",
            });
        } catch (error: any) {
            logger.error("Error unsubscribing from podcast:", error);
            res.status(500).json({
                error: "Failed to unsubscribe",
                message: error.message,
            });
        }
    });

    /**
     * GET /podcasts/:id/refresh
     * Manually refresh podcast feed to check for new episodes
     */
    router.get("/:id/refresh", async (req, res) => {
        try {
            const { id } = req.params;

            logger.debug(`\n [PODCAST] Refresh request`);
            logger.debug(`   Podcast ID: ${id}`);

            const result = await refreshPodcastFeed(id);

            logger.debug(
                `   Refresh complete. ${result.newEpisodesCount} new episodes added.`,
            );

            res.json({
                success: true,
                newEpisodesCount: result.newEpisodesCount,
                totalEpisodes: result.totalEpisodes,
                message: `Found ${result.newEpisodesCount} new episodes`,
            });
        } catch (error: any) {
            if (error.message?.includes("not found")) {
                return res.status(404).json({ error: "Podcast not found" });
            }
            logger.error("Error refreshing podcast:", error);
            res.status(500).json({
                error: "Failed to refresh podcast",
                message: error.message,
            });
        }
    });
}
