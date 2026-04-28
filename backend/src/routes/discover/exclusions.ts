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
 * Exclusion list management for Discover (GET/DELETE).
 */
export function registerExclusionsRoutes(router: Router): void {
    router.get("/exclusions", async (req, res) => {
        try {
            const userId = req.user!.id;

            const exclusions = await prisma.discoverExclusion.findMany({
                where: {
                    userId,
                    expiresAt: { gt: new Date() }, // Only active exclusions
                },
                orderBy: { lastSuggestedAt: "desc" },
            });

            // Return exclusions with names
            const mapped = exclusions.map((exc) => ({
                id: exc.id,
                albumMbid: exc.albumMbid,
                artistName: exc.artistName || "Unknown Artist",
                albumTitle: exc.albumTitle || exc.albumMbid.slice(0, 8) + "...",
                lastSuggestedAt: exc.lastSuggestedAt,
                expiresAt: exc.expiresAt,
            }));

            res.json({
                exclusions: mapped,
                count: exclusions.length,
            });
        } catch (error: any) {
            logger.error("Get exclusions error:", error?.message || error);
            logger.error("Stack:", error?.stack);
            res.status(500).json({
                error: "Failed to get exclusions",
                details: error?.message,
            });
        }
    });

    // DELETE /discover/exclusions - Clear all exclusions for current user
    router.delete("/exclusions", async (req, res) => {
        try {
            const userId = req.user!.id;

            const result = await prisma.discoverExclusion.deleteMany({
                where: { userId },
            });

            logger.debug(
                `[Discovery] Cleared ${result.count} exclusions for user ${userId}`
            );

            res.json({
                success: true,
                message: `Cleared ${result.count} exclusions`,
                clearedCount: result.count,
            });
        } catch (error) {
            logger.error("Clear exclusions error:", error);
            res.status(500).json({ error: "Failed to clear exclusions" });
        }
    });

    // DELETE /discover/exclusions/:id - Remove a specific exclusion
    router.delete("/exclusions/:id", async (req, res) => {
        try {
            const userId = req.user!.id;
            const { id } = req.params;

            const exclusion = await prisma.discoverExclusion.findFirst({
                where: { id, userId },
            });

            if (!exclusion) {
                return res.status(404).json({ error: "Exclusion not found" });
            }

            await prisma.discoverExclusion.delete({
                where: { id },
            });

            res.json({
                success: true,
                message: "Exclusion removed",
            });
        } catch (error) {
            logger.error("Remove exclusion error:", error);
            res.status(500).json({ error: "Failed to remove exclusion" });
        }
    });

    // POST /discover/cleanup-lidarr - Remove discovery-only artists from Lidarr
    // This cleans up artists that were added for discovery but shouldn't remain
}
