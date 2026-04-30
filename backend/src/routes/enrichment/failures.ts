import type { Router } from "express";
import { logger } from "../../utils/logger";
import { requireAdmin } from "../../middleware/auth";
import {
    enrichmentFailureService,
    type GetFailuresOptions,
} from "../../services/enrichmentFailureService";

export function registerEnrichmentFailureRoutes(router: Router): void {
    router.get("/failures", async (req, res) => {
        try {
            const { entityType, includeSkipped, includeResolved, limit, offset } =
                req.query;

            const options: GetFailuresOptions = {};
            if (entityType) {
                options.entityType = entityType as GetFailuresOptions["entityType"];
            }
            if (includeSkipped === "true") {
                options.includeSkipped = true;
            }
            if (includeResolved === "true") {
                options.includeResolved = true;
            }
            if (limit) {
                options.limit = parseInt(limit as string, 10);
            }
            if (offset) {
                options.offset = parseInt(offset as string, 10);
            }

            const result = await enrichmentFailureService.getFailures(options);
            res.json(result);
        } catch (error) {
            logger.error("Get failures error:", error);
            res.status(500).json({ error: "Failed to get failures" });
        }
    });

    router.get("/failures/counts", async (req, res) => {
        try {
            const counts = await enrichmentFailureService.getFailureCounts();
            res.json(counts);
        } catch (error) {
            logger.error("Get failure counts error:", error);
            res.status(500).json({ error: "Failed to get failure counts" });
        }
    });

    router.post("/retry", requireAdmin, async (req, res) => {
        try {
            const { ids } = req.body;

            if (!ids || !Array.isArray(ids) || ids.length === 0) {
                return res
                    .status(400)
                    .json({ error: "Must provide array of failure IDs" });
            }

            await enrichmentFailureService.resetRetryCount(ids);

            const failures = await Promise.all(
                ids.map((id: string) => enrichmentFailureService.getFailure(id)),
            );

            const { prisma } = await import("../../utils/db");
            let queued = 0;
            let skipped = 0;

            for (const failure of failures) {
                if (!failure) continue;

                try {
                    if (failure.entityType === "artist") {
                        const artist = await prisma.artist.findUnique({
                            where: { id: failure.entityId },
                            select: { id: true },
                        });

                        if (!artist) {
                            await enrichmentFailureService.resolveFailures([
                                failure.id,
                            ]);
                            skipped++;
                            continue;
                        }

                        await prisma.artist.update({
                            where: { id: failure.entityId },
                            data: { enrichmentStatus: "pending" },
                        });
                        queued++;
                    } else if (failure.entityType === "track") {
                        const track = await prisma.track.findUnique({
                            where: { id: failure.entityId },
                            select: { id: true },
                        });

                        if (!track) {
                            await enrichmentFailureService.resolveFailures([
                                failure.id,
                            ]);
                            skipped++;
                            continue;
                        }

                        await prisma.track.update({
                            where: { id: failure.entityId },
                            data: { lastfmTags: [] },
                        });
                        queued++;
                    } else if (failure.entityType === "audio") {
                        const track = await prisma.track.findUnique({
                            where: { id: failure.entityId },
                            select: { id: true },
                        });

                        if (!track) {
                            await enrichmentFailureService.resolveFailures([
                                failure.id,
                            ]);
                            skipped++;
                            continue;
                        }

                        await prisma.track.update({
                            where: { id: failure.entityId },
                            data: {
                                analysisStatus: "pending",
                                analysisRetryCount: 0,
                            },
                        });
                        queued++;
                    }
                } catch (error) {
                    logger.error(
                        `Failed to reset ${failure.entityType} ${failure.entityId}:`,
                        error,
                    );
                }
            }

            res.json({
                message: `Queued ${queued} items for retry, ${skipped} skipped (entities no longer exist)`,
                queued,
                skipped,
            });
        } catch (error: any) {
            logger.error("Retry failures error:", error);
            res.status(500).json({
                error: error.message || "Failed to retry failures",
            });
        }
    });

    router.post("/skip", requireAdmin, async (req, res) => {
        try {
            const { ids } = req.body;

            if (!ids || !Array.isArray(ids) || ids.length === 0) {
                return res
                    .status(400)
                    .json({ error: "Must provide array of failure IDs" });
            }

            const count = await enrichmentFailureService.skipFailures(ids);
            res.json({
                message: `Skipped ${count} failures`,
                count,
            });
        } catch (error: any) {
            logger.error("Skip failures error:", error);
            res.status(500).json({
                error: error.message || "Failed to skip failures",
            });
        }
    });

    router.delete("/failures", requireAdmin, async (req, res) => {
        try {
            const entityType = req.query.entityType as
                | "artist"
                | "track"
                | "audio"
                | undefined;

            if (
                entityType &&
                !["artist", "track", "audio"].includes(entityType)
            ) {
                return res.status(400).json({ error: "Invalid entityType" });
            }

            const count =
                await enrichmentFailureService.clearAllFailures(entityType);

            res.json({
                message: `Cleared ${count} failure${count !== 1 ? "s" : ""}`,
                count,
            });
        } catch (error: any) {
            logger.error("Clear all failures error:", error);
            res.status(500).json({
                error: error.message || "Failed to clear failures",
            });
        }
    });

    router.delete("/failures/:id", requireAdmin, async (req, res) => {
        try {
            const count = await enrichmentFailureService.deleteFailures([
                req.params.id,
            ]);
            res.json({
                message: "Failure deleted",
                count,
            });
        } catch (error: any) {
            logger.error("Delete failure error:", error);
            res.status(500).json({
                error: error.message || "Failed to delete failure",
            });
        }
    });
}
