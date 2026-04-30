import type { Router } from "express";
import { logger } from "../../utils/logger";
import { requireAdmin } from "../../middleware/auth";
import {
    getSystemSettings,
    invalidateSystemSettingsCache,
} from "../../utils/systemSettings";
import { rateLimiter } from "../../services/rateLimiter";

export function registerEnrichmentConcurrencyRoutes(router: Router): void {
    router.get("/concurrency", async (req, res) => {
        try {
            const settings = await getSystemSettings();
            const concurrency = settings?.enrichmentConcurrency || 1;

            const artistsPerMin = Math.round(10 * concurrency);
            const tracksPerMin = Math.round(60 * concurrency);

            res.json({
                concurrency,
                estimatedSpeed: `~${artistsPerMin} artists/min, ~${tracksPerMin} tracks/min`,
                artistsPerMin,
                tracksPerMin,
            });
        } catch (error) {
            logger.error("Failed to get enrichment settings:", error);
            res.status(500).json({ error: "Failed to get enrichment settings" });
        }
    });

    router.put("/concurrency", requireAdmin, async (req, res) => {
        try {
            const { concurrency } = req.body;

            if (!concurrency || typeof concurrency !== "number") {
                return res
                    .status(400)
                    .json({ error: "Missing or invalid 'concurrency' parameter" });
            }

            const clampedConcurrency = Math.max(
                1,
                Math.min(5, Math.floor(concurrency)),
            );

            const { prisma } = await import("../../utils/db");
            await prisma.systemSettings.upsert({
                where: { id: "default" },
                create: {
                    id: "default",
                    enrichmentConcurrency: clampedConcurrency,
                },
                update: {
                    enrichmentConcurrency: clampedConcurrency,
                },
            });

            invalidateSystemSettingsCache();

            rateLimiter.updateConcurrencyMultiplier(clampedConcurrency);

            const artistsPerMin = Math.round(10 * clampedConcurrency);
            const tracksPerMin = Math.round(60 * clampedConcurrency);

            logger.debug(
                `[Enrichment Settings] Updated concurrency to ${clampedConcurrency}`,
            );

            res.json({
                concurrency: clampedConcurrency,
                estimatedSpeed: `~${artistsPerMin} artists/min, ~${tracksPerMin} tracks/min`,
                artistsPerMin,
                tracksPerMin,
            });
        } catch (error) {
            logger.error("Failed to update enrichment settings:", error);
            res.status(500).json({ error: "Failed to update enrichment settings" });
        }
    });
}
