import type { Router } from "express";
import { logger } from "../../utils/logger";
import { getEnrichmentProgress } from "../../workers/unifiedEnrichment";
import { enrichmentStateService } from "../../services/enrichmentState";

const PROGRESS_CACHE_MS = 4000;
const STATUS_CACHE_MS = 3000;
let progressCache: { data: unknown; expires: number } | null = null;
let statusCache: { data: unknown; expires: number } | null = null;

/** Clear progress/status cache when enrichment state changes */
export function clearEnrichmentCache(): void {
    progressCache = null;
    statusCache = null;
}

/** GET /progress, GET /status */
export function registerEnrichmentProgressStatusRoutes(router: Router): void {
    /**
     * GET /enrichment/progress
     * Get comprehensive enrichment progress (artists, track tags, audio analysis)
     * Cached 4s to reduce DB load when polled frequently from Settings.
     */
    router.get("/progress", async (req, res) => {
        try {
            const now = Date.now();
            if (progressCache && progressCache.expires > now) {
                return res.json(progressCache.data);
            }
            const progress = await getEnrichmentProgress();
            progressCache = { data: progress, expires: now + PROGRESS_CACHE_MS };
            res.json(progress);
        } catch (error) {
            logger.error("Get enrichment progress error:", error);
            res.status(500).json({ error: "Failed to get progress" });
        }
    });

    /**
     * GET /enrichment/status
     * Get detailed enrichment state (running, paused, etc.)
     * Cached 3s to reduce Redis/DB load when polled frequently from Settings.
     */
    router.get("/status", async (req, res) => {
        try {
            const now = Date.now();
            if (statusCache && statusCache.expires > now) {
                return res.json(statusCache.data);
            }
            const state = await enrichmentStateService.getState();
            const result = state || { status: "idle", currentPhase: null };
            statusCache = { data: result, expires: now + STATUS_CACHE_MS };
            res.json(result);
        } catch (error) {
            logger.error("Get enrichment status error:", error);
            res.status(500).json({ error: "Failed to get status" });
        }
    });
}
