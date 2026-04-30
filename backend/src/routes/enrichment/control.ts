import type { Router } from "express";
import { logger } from "../../utils/logger";
import { requireAdmin } from "../../middleware/auth";
import { enrichmentStateService } from "../../services/enrichmentState";
import {
    runFullEnrichment,
    reRunArtistsOnly,
    reRunMoodTagsOnly,
    reRunAudioAnalysisOnly,
    reRunVibeEmbeddingsOnly,
    triggerEnrichmentNow,
} from "../../workers/unifiedEnrichment";
import { clearEnrichmentCache } from "./progressStatus";

/** Pause/resume/stop, full + selective resets, sync */
export function registerEnrichmentControlRoutes(router: Router): void {
    router.post("/pause", requireAdmin, async (req, res) => {
        try {
            clearEnrichmentCache();
            const state = await enrichmentStateService.pause();
            res.json({
                message: "Enrichment paused",
                state,
            });
        } catch (error: any) {
            logger.error("Pause enrichment error:", error);
            res.status(400).json({
                error: error.message || "Failed to pause enrichment",
            });
        }
    });

    router.post("/resume", requireAdmin, async (req, res) => {
        try {
            clearEnrichmentCache();
            const state = await enrichmentStateService.resume();
            res.json({
                message: "Enrichment resumed",
                state,
            });
        } catch (error: any) {
            logger.error("Resume enrichment error:", error);
            res.status(400).json({
                error: error.message || "Failed to resume enrichment",
            });
        }
    });

    router.post("/stop", requireAdmin, async (req, res) => {
        try {
            clearEnrichmentCache();
            const state = await enrichmentStateService.stop();
            res.json({
                message: "Enrichment stopping...",
                state,
            });
        } catch (error: any) {
            logger.error("Stop enrichment error:", error);
            res.status(400).json({
                error: error.message || "Failed to stop enrichment",
            });
        }
    });

    router.post("/full", requireAdmin, async (req, res) => {
        try {
            clearEnrichmentCache();
            runFullEnrichment().catch((err) => {
                logger.error("Full enrichment error:", err);
            });

            res.json({
                message: "Full enrichment started",
                description:
                    "All artists, track tags, and audio analysis will be re-processed",
            });
        } catch (error) {
            logger.error("Trigger full enrichment error:", error);
            res.status(500).json({ error: "Failed to start full enrichment" });
        }
    });

    router.post("/reset-artists", requireAdmin, async (req, res) => {
        try {
            const result = await reRunArtistsOnly();

            res.json({
                message: "Artist enrichment reset",
                description: `${result.count} artists queued for re-enrichment`,
                count: result.count,
            });
        } catch (error) {
            logger.error("Reset artists error:", error);
            res.status(500).json({ error: "Failed to reset artist enrichment" });
        }
    });

    router.post("/reset-mood-tags", requireAdmin, async (req, res) => {
        try {
            const result = await reRunMoodTagsOnly();

            res.json({
                message: "Mood tags reset",
                description: `${result.count} tracks queued for mood tag re-enrichment`,
                count: result.count,
            });
        } catch (error) {
            logger.error("Reset mood tags error:", error);
            res.status(500).json({ error: "Failed to reset mood tags" });
        }
    });

    router.post("/reset-audio-analysis", requireAdmin, async (req, res) => {
        try {
            const queued = await reRunAudioAnalysisOnly();

            res.json({
                message: "Audio analysis reset",
                description: `${queued} tracks queued for audio re-analysis`,
                count: queued,
            });
        } catch (error) {
            logger.error("Reset audio analysis error:", error);
            res.status(500).json({ error: "Failed to reset audio analysis" });
        }
    });

    router.post("/reset-vibe-embeddings", requireAdmin, async (req, res) => {
        try {
            const queued = await reRunVibeEmbeddingsOnly();

            res.json({
                message: "Vibe embeddings reset",
                description: `${queued} tracks queued for vibe embedding re-analysis`,
                count: queued,
            });
        } catch (error) {
            logger.error("Reset vibe embeddings error:", error);
            res.status(500).json({
                error: "Failed to reset vibe embeddings",
            });
        }
    });

    router.post("/sync", async (req, res) => {
        try {
            clearEnrichmentCache();
            const result = await triggerEnrichmentNow();

            res.json({
                message: "Incremental sync started",
                description: "Processing new and pending items only",
                result,
            });
        } catch (error: any) {
            logger.error("Trigger sync error:", error);
            res.status(500).json({
                error: error.message || "Failed to start sync",
            });
        }
    });
}
