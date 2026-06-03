import type { Router } from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { startOfWeek, endOfWeek } from "date-fns";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { lastFmService } from "../../services/lastfm";
import { lidarrService } from "../../services/lidarr";
import { discoverQueue, scanQueue } from "../../workers/queues";
import { getSystemSettings } from "../../utils/systemSettings";

/**
 * User Discover config (GET/PATCH) and popular-artists endpoint.
 */
export function registerConfigRoutes(router: Router): void {
    // GET /discover/config - Get user's Discover Weekly configuration
    router.get("/config", async (req, res) => {
        try {
            const userId = req.user!.id;

            let config = await prisma.userDiscoverConfig.findUnique({
                where: { userId },
            });

            // Create default config if doesn't exist
            if (!config) {
                config = await prisma.userDiscoverConfig.create({
                    data: {
                        userId,
                        playlistSize: 10,
                        maxRetryAttempts: 3,
                        exclusionMonths: 6,
                        downloadRatio: 1.3,
                        enabled: true,
                    },
                });
            }

            res.json(config);
        } catch (error) {
            logger.error("Get Discover Weekly config error:", error);
            res.status(500).json({ error: "Failed to get configuration" });
        }
    });

    // PATCH /discover/config - Update user's Discover Weekly configuration
    router.patch("/config", async (req, res) => {
        try {
            const userId = req.user!.id;
            const {
                playlistSize,
                maxRetryAttempts,
                exclusionMonths,
                downloadRatio,
                enabled,
                acquisitionMode,
            } = req.body;

            // Validate playlist size
            if (playlistSize !== undefined) {
                const size = parseInt(playlistSize, 10);
                if (isNaN(size) || size < 5 || size > 50 || size % 5 !== 0) {
                    return res.status(400).json({
                        error: "Invalid playlist size. Must be between 5-50 in increments of 5.",
                    });
                }
            }

            // Validate max retry attempts
            if (maxRetryAttempts !== undefined) {
                const retries = parseInt(maxRetryAttempts, 10);
                if (isNaN(retries) || retries < 1 || retries > 10) {
                    return res.status(400).json({
                        error: "Invalid retry attempts. Must be between 1-10.",
                    });
                }
            }

            // Validate exclusion months
            if (exclusionMonths !== undefined) {
                const months = parseInt(exclusionMonths, 10);
                if (isNaN(months) || months < 0 || months > 12) {
                    return res.status(400).json({
                        error: "Invalid exclusion months. Must be between 0-12.",
                    });
                }
            }

            // Validate download ratio
            if (downloadRatio !== undefined) {
                const ratio = parseFloat(downloadRatio);
                if (isNaN(ratio) || ratio < 1.0 || ratio > 2.0) {
                    return res.status(400).json({
                        error: "Invalid download ratio. Must be between 1.0-2.0.",
                    });
                }
            }

            // Validate acquisition mode
            if (
                acquisitionMode !== undefined &&
                acquisitionMode !== "album" &&
                acquisitionMode !== "track"
            ) {
                return res.status(400).json({
                    error: 'Invalid acquisition mode. Must be "album" or "track".',
                });
            }

            const config = await prisma.userDiscoverConfig.upsert({
                where: { userId },
                create: {
                    userId,
                    playlistSize: playlistSize ?? 10,
                    maxRetryAttempts: maxRetryAttempts ?? 3,
                    exclusionMonths: exclusionMonths ?? 6,
                    downloadRatio: downloadRatio ?? 1.3,
                    enabled: enabled ?? true,
                    ...(acquisitionMode !== undefined && { acquisitionMode }),
                },
                update: {
                    ...(playlistSize !== undefined && {
                        playlistSize: parseInt(playlistSize, 10),
                    }),
                    ...(maxRetryAttempts !== undefined && {
                        maxRetryAttempts: parseInt(maxRetryAttempts, 10),
                    }),
                    ...(exclusionMonths !== undefined && {
                        exclusionMonths: parseInt(exclusionMonths, 10),
                    }),
                    ...(downloadRatio !== undefined && {
                        downloadRatio: parseFloat(downloadRatio),
                    }),
                    ...(enabled !== undefined && { enabled }),
                    ...(acquisitionMode !== undefined && { acquisitionMode }),
                },
            });

            res.json(config);
        } catch (error) {
            logger.error("Update Discover Weekly config error:", error);
            res.status(500).json({ error: "Failed to update configuration" });
        }
    });

    // GET /discover/popular-artists - Get popular artists from Last.fm charts
    router.get("/popular-artists", async (req, res) => {
        try {
            const limit = parseInt(req.query.limit as string) || 20;

            const artists = await lastFmService.getTopChartArtists(limit);

            res.json({ artists });
        } catch (error: any) {
            logger.error(
                "[Discover] Get popular artists error:",
                error?.message || error
            );
            // Return empty array instead of 500 - allows homepage to still render
            res.json({ artists: [] });
        }
    });
}
