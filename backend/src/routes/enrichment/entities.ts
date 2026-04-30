import type { Router } from "express";
import { logger } from "../../utils/logger";
import { enrichmentService } from "../../services/enrichment";
import { runFullEnrichment } from "../../workers/unifiedEnrichment";

/** Single-entity enrich + library-wide start */
export function registerEnrichmentEntityRoutes(router: Router): void {
    router.post("/artist/:id", async (req, res) => {
        try {
            const userId = req.user!.id;
            const settings = await enrichmentService.getSettings(userId);

            if (!settings.enabled) {
                return res.status(400).json({ error: "Enrichment is not enabled" });
            }

            const enrichmentData = await enrichmentService.enrichArtist(
                req.params.id,
                settings,
            );

            if (!enrichmentData) {
                return res.status(404).json({ error: "No enrichment data found" });
            }

            if (enrichmentData.confidence > 0.3) {
                await enrichmentService.applyArtistEnrichment(
                    req.params.id,
                    enrichmentData,
                );
            }

            res.json({
                success: true,
                confidence: enrichmentData.confidence,
                data: enrichmentData,
            });
        } catch (error: any) {
            logger.error("Enrich artist error:", error);
            res.status(500).json({
                error: error.message || "Failed to enrich artist",
            });
        }
    });

    router.post("/album/:id", async (req, res) => {
        try {
            const userId = req.user!.id;
            const settings = await enrichmentService.getSettings(userId);

            if (!settings.enabled) {
                return res.status(400).json({ error: "Enrichment is not enabled" });
            }

            const enrichmentData = await enrichmentService.enrichAlbum(
                req.params.id,
                settings,
            );

            if (!enrichmentData) {
                return res.status(404).json({ error: "No enrichment data found" });
            }

            if (enrichmentData.confidence > 0.3) {
                await enrichmentService.applyAlbumEnrichment(
                    req.params.id,
                    enrichmentData,
                );
            }

            res.json({
                success: true,
                confidence: enrichmentData.confidence,
                data: enrichmentData,
            });
        } catch (error: any) {
            logger.error("Enrich album error:", error);
            res.status(500).json({
                error: error.message || "Failed to enrich album",
            });
        }
    });

    router.post("/start", async (req, res) => {
        try {
            const { prisma } = await import("../../utils/db");
            const systemSettings = await prisma.systemSettings.findUnique({
                where: { id: "default" },
                select: { autoEnrichMetadata: true },
            });

            if (!systemSettings?.autoEnrichMetadata) {
                return res.status(400).json({
                    error: "Enrichment is not enabled. Enable it in settings first.",
                });
            }

            runFullEnrichment().catch((err) => {
                logger.error("Background enrichment failed:", err);
            });

            res.json({
                success: true,
                message: "Library enrichment started in background",
            });
        } catch (error: any) {
            logger.error("Start enrichment error:", error);
            res.status(500).json({
                error: error.message || "Failed to start enrichment",
            });
        }
    });
}
