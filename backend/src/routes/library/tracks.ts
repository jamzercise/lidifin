import { Router } from "express";
import path from "path";
import fs from "fs";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { shuffleArray } from "../../utils/shuffle";
import {
    getJellyfinConfig,
    isJellyfinMusicSource,
    getJellyfinTracks,
    resolveTrackReference,
} from "../../services/jellyfin";
import {
    logger,
    TRACK_SORT_MAP,
    MAX_LIMIT,
    resolveIdForJellyfin,
    JELLYFIN_UNREACHABLE_MESSAGE,
} from "./_helpers";

const router = Router();

// GET /library/tracks?albumId=&limit=100&offset=0
router.get("/tracks", async (req, res) => {
    try {
        const {
            albumId,
            limit: limitParam = "100",
            offset: offsetParam = "0",
            sortBy = "name",
        } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 100,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        if (await isJellyfinMusicSource()) {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
            try {
                const { tracks, total } = await getJellyfinTracks(cfg, {
                    limit,
                    offset,
                    albumId: (albumId as string) || undefined,
                });
                return res.json({
                    tracks,
                    total,
                    offset,
                    limit,
                });
            } catch (err: any) {
                logger.warn("[Library] Jellyfin tracks error:", err?.message);
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
        }

        let orderBy: any;
        if (albumId) {
            orderBy = { trackNo: "asc" as const };
        } else {
            orderBy = TRACK_SORT_MAP[sortBy as string] ?? { title: "asc" as const };
        }

        const where: any = {};
        if (albumId) {
            where.albumId = albumId as string;
        }

        const [tracksData, total] = await Promise.all([
            prisma.track.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy,
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
                },
            }),
            prisma.track.count({ where }),
        ]);

        // Add coverArt field to albums
        const tracks = tracksData.map((track) => ({
            ...track,
            album: {
                ...track.album,
                coverArt: track.album.coverUrl,
            },
        }));

        res.json({ tracks, total, offset, limit });
    } catch (error) {
        logger.error("Get tracks error:", error);
        res.status(500).json({ error: "Failed to fetch tracks" });
    }
});

// GET /library/tracks/shuffle?limit=100 - Get random tracks for shuffle play
router.get("/tracks/shuffle", async (req, res) => {
    try {
        const { limit: limitParam = "100" } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 100,
            MAX_LIMIT
        );

        // Get total count of tracks
        const totalTracks = await prisma.track.count();

        if (totalTracks === 0) {
            return res.json({ tracks: [], total: 0 });
        }

        // For small libraries, fetch all and shuffle in memory
        // For large libraries, use database-level randomization for memory efficiency
        let tracksData;
        if (totalTracks <= limit) {
            // Fetch all tracks and shuffle
            tracksData = await prisma.track.findMany({
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
                },
            });
            tracksData = shuffleArray(tracksData);
        } else {
            // For large libraries, use database-level randomization
            // Get random track IDs first (efficient, O(limit) memory)
            const randomIds = await prisma.$queryRaw<{ id: string }[]>`
                SELECT id FROM "Track"
                ORDER BY RANDOM()
                LIMIT ${limit}
            `;

            // Then fetch full track data for selected IDs
            tracksData = await prisma.track.findMany({
                where: {
                    id: { in: randomIds.map((r) => r.id) },
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
                },
            });

            // Shuffle the result to maintain randomness (findMany doesn't preserve order)
            for (let i = tracksData.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [tracksData[i], tracksData[j]] = [tracksData[j], tracksData[i]];
            }
        }

        // Add coverArt field to albums
        const tracks = tracksData.slice(0, limit).map((track) => ({
            ...track,
            album: {
                ...track.album,
                coverArt: track.album.coverUrl,
            },
        }));

        res.json({ tracks, total: totalTracks });
    } catch (error) {
        logger.error("Shuffle tracks error:", error);
        res.status(500).json({ error: "Failed to shuffle tracks" });
    }
});

// GET /library/tracks/:id
router.get("/tracks/:id", async (req, res) => {
    try {
        const id = req.params.id;
        if (id.startsWith("jellyfin:")) {
            const track = await resolveTrackReference(id);
            if (!track) {
                return res.status(404).json({ error: "Track not found" });
            }
            return res.json(track);
        }
        const track = await prisma.track.findUnique({
            where: { id },
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
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Transform to match frontend Track interface: artist at top level
        const formattedTrack = {
            id: track.id,
            title: track.title,
            artist: {
                name: track.album?.artist?.name || "Unknown Artist",
                id: track.album?.artist?.id,
            },
            album: {
                title: track.album?.title || "Unknown Album",
                coverArt: track.album?.coverUrl,
                id: track.album?.id,
            },
            duration: track.duration,
        };

        res.json(formattedTrack);
    } catch (error) {
        logger.error("Get track error:", error);
        res.status(500).json({ error: "Failed to fetch track" });
    }
});

// DELETE /library/tracks/:id
router.delete("/tracks/:id", async (req, res) => {
    try {
        const track = await prisma.track.findUnique({
            where: { id: req.params.id },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Delete file from filesystem if path is available
        if (track.filePath) {
            try {
                const absolutePath = path.join(
                    config.music.musicPath,
                    track.filePath
                );

                if (fs.existsSync(absolutePath)) {
                    fs.unlinkSync(absolutePath);
                    logger.debug(`[DELETE] Deleted file: ${absolutePath}`);
                }
            } catch (err) {
                logger.warn("[DELETE] Could not delete file:", err);
                // Continue with database deletion even if file deletion fails
            }
        }

        // Delete from database (cascade will handle related records)
        await prisma.track.delete({
            where: { id: track.id },
        });

        logger.debug(`[DELETE] Deleted track: ${track.title}`);

        res.json({ message: "Track deleted successfully" });
    } catch (error) {
        logger.error("Delete track error:", error);
        res.status(500).json({ error: "Failed to delete track" });
    }
});

export default router;
