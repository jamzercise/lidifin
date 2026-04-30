import type { Router } from "express";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";

/** Manual metadata overrides + reset to canonical */
export function registerEnrichmentMetadataRoutes(router: Router): void {
    router.put("/artists/:id/metadata", async (req, res) => {
        try {
            const { name, bio, genres, heroUrl } = req.body;

            const updateData: Record<string, unknown> = {};
            let hasOverrides = false;

            if (name !== undefined) {
                updateData.displayName = name;
                hasOverrides = true;
            }
            if (bio !== undefined) {
                updateData.userSummary = bio;
                hasOverrides = true;
            }
            if (heroUrl !== undefined) {
                updateData.userHeroUrl = heroUrl;
                hasOverrides = true;
            }
            if (genres !== undefined) {
                updateData.userGenres = genres;
                hasOverrides = true;
            }

            if (hasOverrides) {
                updateData.hasUserOverrides = true;
            }

            const { prisma } = await import("../../utils/db");
            const artist = await prisma.artist.update({
                where: { id: req.params.id },
                data: updateData,
                include: {
                    albums: {
                        select: {
                            id: true,
                            title: true,
                            year: true,
                            coverUrl: true,
                        },
                    },
                },
            });

            try {
                await redisClient.del(`hero:${req.params.id}`);
            } catch (err) {
                logger.warn("Failed to invalidate Redis cache:", err);
            }

            res.json(artist);
        } catch (error: any) {
            logger.error("Update artist metadata error:", error);
            res.status(500).json({
                error: error.message || "Failed to update artist",
            });
        }
    });

    router.put("/albums/:id/metadata", async (req, res) => {
        try {
            const { title, year, genres, coverUrl } = req.body;

            const updateData: Record<string, unknown> = {};
            let hasOverrides = false;

            if (title !== undefined) {
                updateData.displayTitle = title;
                hasOverrides = true;
            }
            if (year !== undefined) {
                updateData.displayYear = parseInt(year, 10);
                hasOverrides = true;
            }
            if (coverUrl !== undefined) {
                updateData.userCoverUrl = coverUrl;
                hasOverrides = true;
            }
            if (genres !== undefined) {
                updateData.userGenres = genres;
                hasOverrides = true;
            }

            if (hasOverrides) {
                updateData.hasUserOverrides = true;
            }

            const { prisma } = await import("../../utils/db");
            const album = await prisma.album.update({
                where: { id: req.params.id },
                data: updateData,
                include: {
                    artist: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                    tracks: {
                        select: {
                            id: true,
                            title: true,
                            trackNo: true,
                            duration: true,
                        },
                    },
                },
            });

            res.json(album);
        } catch (error: any) {
            logger.error("Update album metadata error:", error);
            res.status(500).json({
                error: error.message || "Failed to update album",
            });
        }
    });

    router.put("/tracks/:id/metadata", async (req, res) => {
        try {
            const { title, trackNo } = req.body;

            const updateData: Record<string, unknown> = {};
            let hasOverrides = false;

            if (title !== undefined) {
                updateData.displayTitle = title;
                hasOverrides = true;
            }
            if (trackNo !== undefined) {
                updateData.displayTrackNo = parseInt(trackNo, 10);
                hasOverrides = true;
            }

            if (hasOverrides) {
                updateData.hasUserOverrides = true;
            }

            const { prisma } = await import("../../utils/db");
            const track = await prisma.track.update({
                where: { id: req.params.id },
                data: updateData,
                include: {
                    album: {
                        select: {
                            id: true,
                            title: true,
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            });

            res.json(track);
        } catch (error: any) {
            logger.error("Update track metadata error:", error);
            res.status(500).json({
                error: error.message || "Failed to update track",
            });
        }
    });

    router.post("/artists/:id/reset", async (req, res) => {
        try {
            const { prisma } = await import("../../utils/db");

            const existingArtist = await prisma.artist.findUnique({
                where: { id: req.params.id },
                select: { id: true },
            });

            if (!existingArtist) {
                return res.status(404).json({
                    error: "Artist not found",
                    message: "The artist may have been deleted",
                });
            }

            const artist = await prisma.artist.update({
                where: { id: req.params.id },
                data: {
                    displayName: null,
                    userSummary: null,
                    userHeroUrl: null,
                    userGenres: [],
                    hasUserOverrides: false,
                },
                include: {
                    albums: {
                        select: {
                            id: true,
                            title: true,
                            year: true,
                            coverUrl: true,
                        },
                    },
                },
            });

            try {
                await redisClient.del(`hero:${req.params.id}`);
            } catch (err) {
                logger.warn("Failed to invalidate Redis cache:", err);
            }

            res.json({
                message: "Artist metadata reset to original values",
                artist,
            });
        } catch (error: any) {
            if (error.code === "P2025") {
                return res.status(404).json({
                    error: "Artist not found",
                    message: "The artist may have been deleted",
                });
            }
            logger.error("Reset artist metadata error:", error);
            res.status(500).json({
                error: error.message || "Failed to reset artist metadata",
            });
        }
    });

    router.post("/albums/:id/reset", async (req, res) => {
        try {
            const { prisma } = await import("../../utils/db");

            const existingAlbum = await prisma.album.findUnique({
                where: { id: req.params.id },
                select: { id: true },
            });

            if (!existingAlbum) {
                return res.status(404).json({
                    error: "Album not found",
                    message: "The album may have been deleted",
                });
            }

            const album = await prisma.album.update({
                where: { id: req.params.id },
                data: {
                    displayTitle: null,
                    displayYear: null,
                    userCoverUrl: null,
                    userGenres: [],
                    hasUserOverrides: false,
                },
                include: {
                    artist: {
                        select: {
                            id: true,
                            name: true,
                        },
                    },
                    tracks: {
                        select: {
                            id: true,
                            title: true,
                            trackNo: true,
                            duration: true,
                        },
                    },
                },
            });

            res.json({
                message: "Album metadata reset to original values",
                album,
            });
        } catch (error: any) {
            if (error.code === "P2025") {
                return res.status(404).json({
                    error: "Album not found",
                    message: "The album may have been deleted",
                });
            }
            logger.error("Reset album metadata error:", error);
            res.status(500).json({
                error: error.message || "Failed to reset album metadata",
            });
        }
    });

    router.post("/tracks/:id/reset", async (req, res) => {
        try {
            const { prisma } = await import("../../utils/db");

            const existingTrack = await prisma.track.findUnique({
                where: { id: req.params.id },
                select: { id: true },
            });

            if (!existingTrack) {
                return res.status(404).json({
                    error: "Track not found",
                    message: "The track may have been deleted",
                });
            }

            const track = await prisma.track.update({
                where: { id: req.params.id },
                data: {
                    displayTitle: null,
                    displayTrackNo: null,
                    hasUserOverrides: false,
                },
                include: {
                    album: {
                        select: {
                            id: true,
                            title: true,
                            artist: {
                                select: {
                                    id: true,
                                    name: true,
                                },
                            },
                        },
                    },
                },
            });

            res.json({
                message: "Track metadata reset to original values",
                track,
            });
        } catch (error: any) {
            if (error.code === "P2025") {
                return res.status(404).json({
                    error: "Track not found",
                    message: "The track may have been deleted",
                });
            }
            logger.error("Reset track metadata error:", error);
            res.status(500).json({
                error: error.message || "Failed to reset track metadata",
            });
        }
    });
}
