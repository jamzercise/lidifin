import type { Router } from "express";
import { logger } from "../../utils/logger";
import { programmaticPlaylistService } from "../../services/programmaticPlaylists";
import { redisClient } from "../../utils/redis";
import { getRequestUserId } from "./helpers";

/** GET /mixes — cached programmatic mix list */
export function registerMixLibraryRoute(router: Router): void {
    /**
     * @openapi
     * /mixes:
     *   get:
     *     summary: Get all programmatic mixes
     *     description: Returns all auto-generated mixes (era-based, genre-based, top tracks, rediscover, artist similar, random discovery)
     *     tags: [Mixes]
     *     security:
     *       - sessionAuth: []
     *       - apiKeyAuth: []
     *     responses:
     *       200:
     *         description: List of programmatic mixes
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: object
     *                 properties:
     *                   id:
     *                     type: string
     *                     example: "era-2000"
     *                   type:
     *                     type: string
     *                     enum: [era, genre, top-tracks, rediscover, artist-similar, random-discovery]
     *                   name:
     *                     type: string
     *                     example: "Your 2000s Mix"
     *                   description:
     *                     type: string
     *                     example: "Music from the 2000s in your library"
     *                   trackIds:
     *                     type: array
     *                     items:
     *                       type: string
     *                   coverUrls:
     *                     type: array
     *                     items:
     *                       type: string
     *                     description: Album covers for mosaic display (up to 4)
     *                   trackCount:
     *                     type: integer
     *                     example: 42
     *       401:
     *         description: Not authenticated
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Error'
     */
    router.get("/", async (req, res) => {
        try {
            const userId = getRequestUserId(req);
            if (!userId) {
                return res.status(401).json({ error: "Not authenticated" });
            }

            // Check cache first (mixes are expensive to compute)
            const cacheKey = `mixes:${userId}`;
            const cached = await redisClient.get(cacheKey);

            if (cached) {
                return res.json(JSON.parse(cached));
            }

            // Generate all mixes
            const mixes =
                await programmaticPlaylistService.generateAllMixes(userId);

            // Cache for 1 hour
            await redisClient.setEx(cacheKey, 3600, JSON.stringify(mixes));

            res.json(mixes);
        } catch (error) {
            logger.error("Get mixes error:", error);
            res.status(500).json({ error: "Failed to get mixes" });
        }
    });
}
