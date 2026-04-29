import type { Router } from "express";
import axios from "axios";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { rssParserService } from "../../services/rss-parser";

/** List subscriptions, home slices, and iTunes-based discovery / preview. */
export function registerPodcastLibraryAndDiscoverRoutes(router: Router): void {
    router.get("/", async (req, res) => {
        try {
            const subscriptions = await prisma.podcastSubscription.findMany({
                where: { userId: req.user!.id },
                include: {
                    podcast: {
                        include: {
                            episodes: {
                                orderBy: { publishedAt: "desc" },
                                take: 5, // Get latest 5 episodes per podcast
                                include: {
                                    progress: {
                                        where: { userId: req.user!.id },
                                    },
                                },
                            },
                        },
                    },
                },
                orderBy: { subscribedAt: "desc" },
            });

            const podcasts = subscriptions.map((sub) => {
                const podcast = sub.podcast;
                return {
                    id: podcast.id,
                    title: podcast.title,
                    author: podcast.author,
                    description: podcast.description,
                    coverUrl: podcast.localCoverPath
                        ? `/podcasts/${podcast.id}/cover`
                        : podcast.imageUrl, // Fallback to original URL if not cached
                    episodeCount: podcast.episodeCount,
                    autoDownloadEpisodes: false, // Per-podcast auto-download not yet implemented
                    episodes: podcast.episodes.map((ep) => ({
                        id: ep.id,
                        title: ep.title,
                        description: ep.description,
                        duration: ep.duration,
                        publishedAt: ep.publishedAt,
                        coverUrl: ep.localCoverPath
                            ? `/podcasts/episodes/${ep.id}/cover`
                            : ep.imageUrl, // Fallback to original URL
                        progress: ep.progress[0]
                            ? {
                                  currentTime: ep.progress[0].currentTime,
                                  progress:
                                      ep.progress[0].duration > 0
                                          ? (ep.progress[0].currentTime /
                                                ep.progress[0].duration) *
                                            100
                                          : 0,
                                  isFinished: ep.progress[0].isFinished,
                                  lastPlayedAt: ep.progress[0].lastPlayedAt,
                              }
                            : null,
                    })),
                };
            });

            res.json(podcasts);
        } catch (error: any) {
            logger.error("Error fetching podcasts:", error);
            res.status(500).json({
                error: "Failed to fetch podcasts",
                message: error.message,
            });
        }
    });

    /**
     * GET /podcasts/new-episodes
     * Episodes from subscribed podcasts that are new (≤14 days) and unplayed (<1% listened)
     */
    router.get("/new-episodes", async (req, res) => {
        try {
            const { limit = "20" } = req.query;
            const limitNum = Math.min(
                Math.max(1, parseInt(limit as string, 10) || 20),
                50,
            );
            const userId = req.user!.id;

            const fourteenDaysAgo = new Date();
            fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

            const episodes = await prisma.podcastEpisode.findMany({
                where: {
                    podcast: {
                        subscriptions: { some: { userId } },
                    },
                    publishedAt: { gte: fourteenDaysAgo },
                },
                include: {
                    podcast: {
                        select: {
                            id: true,
                            title: true,
                            author: true,
                            imageUrl: true,
                            localCoverPath: true,
                        },
                    },
                    progress: {
                        where: { userId },
                        take: 1,
                    },
                },
                orderBy: { publishedAt: "desc" },
                take: limitNum * 2,
            });

            const unplayed = episodes.filter((ep) => {
                const prog = ep.progress[0];
                if (!prog) return true;
                if (prog.duration <= 0) return true;
                const pct = (prog.currentTime / prog.duration) * 100;
                return pct < 1;
            });

            const limited = unplayed.slice(0, limitNum).map((ep) => {
                const prog = ep.progress[0];
                return {
                    id: ep.id,
                    title: ep.title,
                    duration: ep.duration,
                    publishedAt: ep.publishedAt,
                    mimeType: ep.mimeType ?? undefined,
                    coverUrl: ep.localCoverPath
                        ? `/podcasts/episodes/${ep.id}/cover`
                        : (ep.imageUrl ?? ep.podcast.imageUrl),
                    podcast: {
                        id: ep.podcast.id,
                        title: ep.podcast.title,
                        author: ep.podcast.author,
                        coverUrl: ep.podcast.localCoverPath
                            ? `/podcasts/${ep.podcast.id}/cover`
                            : ep.podcast.imageUrl,
                    },
                    progress: prog
                        ? {
                              currentTime: prog.currentTime,
                              progress:
                                  prog.duration > 0
                                      ? (prog.currentTime / prog.duration) * 100
                                      : 0,
                              isFinished: prog.isFinished,
                              lastPlayedAt: prog.lastPlayedAt,
                          }
                        : null,
                };
            });

            res.json(limited);
        } catch (error: any) {
            logger.error("Error fetching new episodes:", error);
            res.status(500).json({
                error: "Failed to fetch new episodes",
                message: error.message,
            });
        }
    });

    /**
     * GET /podcasts/continue-listening
     * Partially played episodes (1% <= progress < 100%), ordered by publishedAt desc
     */
    router.get("/continue-listening", async (req, res) => {
        try {
            const { limit = "20" } = req.query;
            const limitNum = Math.min(
                Math.max(1, parseInt(limit as string, 10) || 20),
                50,
            );
            const userId = req.user!.id;

            const progressRecords = await prisma.podcastProgress.findMany({
                where: {
                    userId,
                    isFinished: false,
                    currentTime: { gt: 0 },
                    duration: { gt: 0 },
                },
                include: {
                    episode: {
                        include: {
                            podcast: {
                                select: {
                                    id: true,
                                    title: true,
                                    author: true,
                                    imageUrl: true,
                                    localCoverPath: true,
                                },
                            },
                        },
                    },
                },
                orderBy: { lastPlayedAt: "desc" },
                take: limitNum * 3,
            });

            const partiallyPlayed = progressRecords
                .filter((pp) => {
                    const pct = (pp.currentTime / pp.duration) * 100;
                    return pct >= 1 && pct < 100;
                })
                .sort(
                    (a, b) =>
                        new Date(b.episode.publishedAt).getTime() -
                        new Date(a.episode.publishedAt).getTime(),
                )
                .slice(0, limitNum)
                .map((pp) => {
                    const ep = pp.episode;
                    return {
                        id: ep.id,
                        title: ep.title,
                        duration: ep.duration,
                        publishedAt: ep.publishedAt,
                        mimeType: ep.mimeType ?? undefined,
                        coverUrl: ep.localCoverPath
                            ? `/podcasts/episodes/${ep.id}/cover`
                            : (ep.imageUrl ?? ep.podcast.imageUrl),
                        podcast: {
                            id: ep.podcast.id,
                            title: ep.podcast.title,
                            author: ep.podcast.author,
                            coverUrl: ep.podcast.localCoverPath
                                ? `/podcasts/${ep.podcast.id}/cover`
                                : ep.podcast.imageUrl,
                        },
                        progress: {
                            currentTime: pp.currentTime,
                            progress: (pp.currentTime / pp.duration) * 100,
                            isFinished: pp.isFinished,
                            lastPlayedAt: pp.lastPlayedAt,
                        },
                    };
                });

            res.json(partiallyPlayed);
        } catch (error: any) {
            logger.error("Error fetching continue listening:", error);
            res.status(500).json({
                error: "Failed to fetch continue listening",
                message: error.message,
            });
        }
    });

    /**
     * GET /podcasts/discover/top
     * Get top podcasts - just search iTunes like the search bar does
     */
    router.get("/discover/top", async (req, res) => {
        try {
            const { limit = "20" } = req.query;
            const podcastLimit = Math.min(parseInt(limit as string, 10), 50);

            logger.debug(`\n[TOP PODCASTS] Request (limit: ${podcastLimit})`);

            // Simple iTunes search - same as the working search bar!
            const itunesResponse = await axios.get(
                "https://itunes.apple.com/search",
                {
                    params: {
                        term: "podcast",
                        media: "podcast",
                        entity: "podcast",
                        limit: podcastLimit,
                    },
                    timeout: 5000,
                },
            );

            const podcasts = itunesResponse.data.results.map(
                (podcast: any) => ({
                    id: podcast.collectionId.toString(),
                    title: podcast.collectionName,
                    author: podcast.artistName,
                    coverUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
                    feedUrl: podcast.feedUrl,
                    genres: podcast.genres || [],
                    episodeCount: podcast.trackCount || 0,
                    itunesId: podcast.collectionId,
                    isExternal: true,
                }),
            );

            logger.debug(`   Found ${podcasts.length} podcasts`);
            res.json(podcasts);
        } catch (error: any) {
            logger.error("Error fetching top podcasts:", error);
            res.status(500).json({
                error: "Failed to fetch top podcasts",
                message: error.message,
            });
        }
    });

    /**
     * GET /podcasts/discover/genres
     * Get podcasts by specific genres/topics - using simple iTunes search like the search bar
     */
    router.get("/discover/genres", async (req, res) => {
        try {
            const { genres } = req.query; // Comma-separated genre IDs

            logger.debug(`\n[GENRE PODCASTS] Request (genres: ${genres})`);

            if (!genres || typeof genres !== "string") {
                return res.status(400).json({
                    error: "genres parameter required (comma-separated genre IDs)",
                });
            }

            const genreIds = genres
                .split(",")
                .map((id) => parseInt(id.trim(), 10));

            // Map genre IDs to search terms - same approach as the working search!
            const genreSearchTerms: { [key: number]: string } = {
                1303: "comedy podcast", // Comedy
                1324: "society culture podcast", // Society & Culture
                1489: "news podcast", // News
                1488: "true crime podcast", // True Crime
                1321: "business podcast", // Business
                1545: "sports podcast", // Sports
                1502: "gaming hobbies podcast", // Leisure (Gaming & Hobbies)
            };

            // Fetch podcasts for each genre using simple iTunes search - PARALLEL execution
            const genreFetchPromises = genreIds.map(async (genreId) => {
                const searchTerm = genreSearchTerms[genreId] || "podcast";
                logger.debug(`    Searching for "${searchTerm}"...`);

                try {
                    // Simple iTunes search - same as the working search bar!
                    const itunesResponse = await axios.get(
                        "https://itunes.apple.com/search",
                        {
                            params: {
                                term: searchTerm,
                                media: "podcast",
                                entity: "podcast",
                                limit: 10,
                            },
                            timeout: 5000,
                        },
                    );

                    const podcasts = itunesResponse.data.results.map(
                        (podcast: any) => ({
                            id: podcast.collectionId.toString(),
                            title: podcast.collectionName,
                            author: podcast.artistName,
                            coverUrl:
                                podcast.artworkUrl600 || podcast.artworkUrl100,
                            feedUrl: podcast.feedUrl,
                            genres: podcast.genres || [],
                            episodeCount: podcast.trackCount || 0,
                            itunesId: podcast.collectionId,
                            isExternal: true,
                        }),
                    );

                    logger.debug(
                        `      Found ${podcasts.length} podcasts for genre ${genreId}`,
                    );
                    return { genreId, podcasts };
                } catch (error: any) {
                    logger.error(
                        `       Error searching for ${searchTerm}:`,
                        error.message,
                    );
                    return { genreId, podcasts: [] };
                }
            });

            // Wait for all genre searches to complete in parallel
            const genreResults = await Promise.all(genreFetchPromises);

            // Convert array of results to object keyed by genreId
            const results: any = {};
            for (const { genreId, podcasts } of genreResults) {
                results[genreId] = podcasts;
            }

            logger.debug(
                `   Fetched podcasts for ${genreIds.length} genres (parallel)`,
            );
            res.json(results);
        } catch (error: any) {
            logger.error("Error fetching genre podcasts:", error);
            res.status(500).json({
                error: "Failed to fetch genre podcasts",
                message: error.message,
            });
        }
    });

    /**
     * GET /podcasts/discover/genre/:genreId
     * Get paginated podcasts for a specific genre with offset support
     */
    router.get("/discover/genre/:genreId", async (req, res) => {
        try {
            const { genreId } = req.params;
            const { limit = "20", offset = "0" } = req.query;

            const podcastLimit = Math.min(parseInt(limit as string, 10), 50);
            const podcastOffset = parseInt(offset as string, 10);

            logger.debug(
                `\n[GENRE PAGINATED] Request (genre: ${genreId}, limit: ${podcastLimit}, offset: ${podcastOffset})`,
            );

            // Map genre IDs to search terms
            const genreSearchTerms: { [key: string]: string } = {
                "1303": "comedy podcast",
                "1324": "society culture podcast",
                "1489": "news podcast",
                "1488": "true crime podcast",
                "1321": "business podcast",
                "1545": "sports podcast",
                "1502": "gaming hobbies podcast",
            };

            const searchTerm = genreSearchTerms[genreId] || "podcast";
            logger.debug(
                `    Searching for "${searchTerm}" (offset: ${podcastOffset})...`,
            );

            // iTunes API doesn't support offset directly, so we request more and slice
            // This is a limitation but works for reasonable pagination
            const totalToFetch = podcastOffset + podcastLimit;

            const itunesResponse = await axios.get(
                "https://itunes.apple.com/search",
                {
                    params: {
                        term: searchTerm,
                        media: "podcast",
                        entity: "podcast",
                        limit: Math.min(totalToFetch, 200), // iTunes max is 200
                    },
                    timeout: 5000,
                },
            );

            const allPodcasts = itunesResponse.data.results.map(
                (podcast: any) => ({
                    id: podcast.collectionId.toString(),
                    title: podcast.collectionName,
                    author: podcast.artistName,
                    coverUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
                    feedUrl: podcast.feedUrl,
                    genres: podcast.genres || [],
                    episodeCount: podcast.trackCount || 0,
                    itunesId: podcast.collectionId,
                    isExternal: true,
                }),
            );

            // Slice for pagination
            const podcasts = allPodcasts.slice(
                podcastOffset,
                podcastOffset + podcastLimit,
            );

            logger.debug(
                `   Found ${podcasts.length} podcasts (total available: ${allPodcasts.length})`,
            );
            res.json(podcasts);
        } catch (error: any) {
            logger.error("Error fetching paginated genre podcasts:", error);
            res.status(500).json({
                error: "Failed to fetch podcasts",
                message: error.message,
            });
        }
    });

    /**
     * GET /podcasts/preview/:itunesId
     * Preview a podcast by iTunes ID (for discovery, before subscribing)
     * Returns basic podcast info without requiring a subscription
     */
    router.get("/preview/:itunesId", async (req, res) => {
        try {
            const { itunesId } = req.params;

            logger.debug(`\n [PODCAST PREVIEW] iTunes ID: ${itunesId}`);

            // Try to fetch from iTunes API
            const itunesResponse = await axios.get(
                "https://itunes.apple.com/lookup",
                {
                    params: {
                        id: itunesId,
                        entity: "podcast",
                    },
                    timeout: 5000,
                },
            );

            if (
                !itunesResponse.data.results ||
                itunesResponse.data.results.length === 0
            ) {
                return res.status(404).json({ error: "Podcast not found" });
            }

            const podcastData = itunesResponse.data.results[0];

            // Check if user is already subscribed
            const existingPodcast = await prisma.podcast.findFirst({
                where: {
                    OR: [{ id: itunesId }, { feedUrl: podcastData.feedUrl }],
                },
            });

            let isSubscribed = false;
            if (existingPodcast) {
                const subscription =
                    await prisma.podcastSubscription.findUnique({
                        where: {
                            userId_podcastId: {
                                userId: req.user!.id,
                                podcastId: existingPodcast.id,
                            },
                        },
                    });
                isSubscribed = !!subscription;
            }

            // Fetch description and episodes from RSS feed (iTunes API doesn't provide them)
            let description = "";
            let previewEpisodes: any[] = [];
            if (podcastData.feedUrl) {
                try {
                    const feedData = await rssParserService.parseFeed(
                        podcastData.feedUrl,
                    );
                    description = feedData.podcast.description || "";

                    // Get first 3 episodes for preview
                    previewEpisodes = (feedData.episodes || [])
                        .slice(0, 3)
                        .map((episode: any) => ({
                            title: episode.title,
                            publishedAt: episode.publishedAt,
                            duration: episode.duration || 0,
                        }));

                    logger.debug(
                        ` [PODCAST PREVIEW] Fetched description (${description.length} chars) and ${previewEpisodes.length} preview episodes`,
                    );
                } catch (error) {
                    logger.warn(
                        `  Failed to fetch RSS feed for preview:`,
                        error,
                    );
                    // Continue without description and episodes
                }
            }

            res.json({
                itunesId: podcastData.collectionId.toString(),
                title: podcastData.collectionName,
                author: podcastData.artistName,
                description: description,
                coverUrl:
                    podcastData.artworkUrl600 || podcastData.artworkUrl100,
                feedUrl: podcastData.feedUrl,
                genres: podcastData.genres || [],
                episodeCount: podcastData.trackCount || 0,
                previewEpisodes: previewEpisodes,
                isSubscribed,
                subscribedPodcastId: isSubscribed ? existingPodcast!.id : null,
            });
        } catch (error: any) {
            logger.error("Error previewing podcast:", error);
            res.status(500).json({
                error: "Failed to preview podcast",
                message: error.message,
            });
        }
    });
}
