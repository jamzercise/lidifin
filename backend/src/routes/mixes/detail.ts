import type { Router } from "express";
import { logger } from "../../utils/logger";
import { programmaticPlaylistService } from "../../services/programmaticPlaylists";
import { resolveTrackReferences } from "../../services/jellyfin";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { generateMixCoverSvg } from "../../services/mixCoverService";
import { config } from "../../config";
import { getRequestUserId } from "./helpers";

/** POST /refresh, GET|POST /:id/save, GET /:id/cover, GET /:id */
export function registerMixDetailRoutes(router: Router): void {
    router.post("/refresh", async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }

            // Clear cache
            const cacheKey = `mixes:${userId}`;
            await redisClient.del(cacheKey);

            // Regenerate mixes with random selection (not date-based)
            const mixes = await programmaticPlaylistService.generateAllMixes(
                userId,
                true,
            );

            // Cache for 1 hour
            await redisClient.setEx(cacheKey, 3600, JSON.stringify(mixes));

            res.json({ message: "Mixes refreshed", mixes });
        } catch (error) {
            logger.error("Refresh mixes error:", error);
            res.status(500).json({ error: "Failed to refresh mixes" });
        }
    });

    /**
     * @openapi
     * /mixes/{id}/save:
     *   post:
     *     summary: Save a mix as a playlist
     *     description: Creates a new playlist with all tracks from the specified mix
     *     tags: [Mixes]
     *     security:
     *       - sessionAuth: []
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: Mix ID to save as playlist
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               name:
     *                 type: string
     *                 description: Optional custom name for the playlist (defaults to mix name)
     *     responses:
     *       200:
     *         description: Playlist created successfully
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 id:
     *                   type: string
     *                 name:
     *                   type: string
     *                 trackCount:
     *                   type: integer
     *       404:
     *         description: Mix not found
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Error'
     *       401:
     *         description: Not authenticated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Error'
     */
    router.post("/:id/save", async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }
            const mixId = req.params.id;
            const customName = req.body.name;

            // Get the mix with track details
            const cacheKey = `mixes:${userId}`;
            let mixes;

            const cached = await redisClient.get(cacheKey);
            if (cached) {
                mixes = JSON.parse(cached);
            } else {
                mixes =
                    await programmaticPlaylistService.generateAllMixes(userId);
                await redisClient.setEx(cacheKey, 3600, JSON.stringify(mixes));
            }

            const mix = mixes.find((m: any) => m.id === mixId);

            if (!mix) {
                return res.status(404).json({ error: "Mix not found" });
            }

            const existingPlaylist = await prisma.playlist.findFirst({
                where: {
                    userId,
                    mixId: mix.id,
                },
                select: {
                    id: true,
                    name: true,
                },
            });

            if (existingPlaylist) {
                return res.status(409).json({
                    error: "Mix already saved as playlist",
                    playlistId: existingPlaylist.id,
                    name: existingPlaylist.name,
                });
            }

            // Create playlist
            const playlist = await prisma.playlist.create({
                data: {
                    userId,
                    mixId: mix.id,
                    name: customName || mix.name,
                    isPublic: false,
                },
            });

            // Add all tracks to the playlist
            const playlistItems = mix.trackIds.map(
                (trackId: string, index: number) => ({
                    playlistId: playlist.id,
                    trackId,
                    sort: index,
                }),
            );

            await prisma.playlistItem.createMany({
                data: playlistItems,
            });

            logger.debug(
                `[MIXES] Saved mix ${mixId} as playlist ${playlist.id} (${mix.trackIds.length} tracks)`,
            );

            res.json({
                id: playlist.id,
                name: playlist.name,
                trackCount: mix.trackIds.length,
            });
        } catch (error) {
            logger.error("Save mix as playlist error:", error);
            res.status(500).json({ error: "Failed to save mix as playlist" });
        }
    });

    /**
     * @openapi
     * /mixes/{id}:
     *   get:
     *     summary: Get a specific mix with full track details
     *     tags: [Mixes]
     *     security:
     *       - sessionAuth: []
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: Mix ID (e.g., "era-2000", "genre-rock", "top-tracks")
     *     responses:
     *       200:
     *         description: Mix with full track details
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 id:
     *                   type: string
     *                 type:
     *                   type: string
     *                 name:
     *                   type: string
     *                 description:
     *                   type: string
     *                 trackIds:
     *                   type: array
     *                   items:
     *                     type: string
     *                 coverUrls:
     *                   type: array
     *                   items:
     *                     type: string
     *                 trackCount:
     *                   type: integer
     *                 tracks:
     *                   type: array
     *                   items:
     *                     $ref: '#/components/schemas/Track'
     *       404:
     *         description: Mix not found
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Error'
     *       401:
     *         description: Not authenticated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Error'
     */
    router.get("/:id/cover", async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }
            const mixId = req.params.id;

            const cacheKey = `mixes:${userId}`;
            let mixes;
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                mixes = JSON.parse(cached);
            } else {
                mixes =
                    await programmaticPlaylistService.generateAllMixes(userId);
                await redisClient.setEx(cacheKey, 3600, JSON.stringify(mixes));
            }

            const mix = mixes.find((m: any) => m.id === mixId);
            if (!mix) {
                return res.status(404).json({ error: "Mix not found" });
            }

            const apiBaseUrl =
                process.env.API_URL || `http://localhost:${config.port}`;
            const size = parseInt(String(req.query.size || "400"), 10) || 400;
            const clampedSize = Math.min(600, Math.max(100, size));

            const dataUrl = await generateMixCoverSvg(
                {
                    id: mix.id,
                    type: mix.type,
                    name: mix.name,
                    color: mix.color,
                    coverUrls: mix.coverUrls || [],
                },
                clampedSize,
                apiBaseUrl,
            );

            const base64 = dataUrl.replace(/^data:image\/svg\+xml;base64,/, "");
            const svg = Buffer.from(base64, "base64").toString("utf-8");

            res.setHeader("Content-Type", "image/svg+xml");
            res.setHeader(
                "Cache-Control",
                "public, max-age=3600, s-maxage=3600",
            );
            res.send(svg);
        } catch (error) {
            logger.error("Get mix cover error:", error);
            res.status(500).json({ error: "Failed to generate mix cover" });
        }
    });

    router.get("/:id", async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }
            const mixId = req.params.id;

            // Get all mixes (from cache if available)
            const cacheKey = `mixes:${userId}`;
            let mixes;

            const cached = await redisClient.get(cacheKey);
            if (cached) {
                mixes = JSON.parse(cached);
            } else {
                mixes =
                    await programmaticPlaylistService.generateAllMixes(userId);
                await redisClient.setEx(cacheKey, 3600, JSON.stringify(mixes));
            }

            // Find the specific mix
            const mix = mixes.find((m: any) => m.id === mixId);

            if (!mix) {
                return res.status(404).json({ error: "Mix not found" });
            }

            // Resolve tracks (handles both Jellyfin IDs and native Prisma IDs)
            const resolved = await resolveTrackReferences(mix.trackIds || []);
            const orderedTracks = resolved
                .map((t) =>
                    t
                        ? {
                              id: t.id,
                              title: t.title,
                              duration: t.duration,
                              albumId: t.album.id,
                              album: {
                                  title: t.album.title,
                                  coverUrl: t.album.coverArt,
                                  artist: t.artist,
                              },
                          }
                        : null,
                )
                .filter(Boolean);

            res.json({
                ...mix,
                tracks: orderedTracks,
            });
        } catch (error) {
            logger.error("Get mix error:", error);
            res.status(500).json({ error: "Failed to get mix" });
        }
    });
}
