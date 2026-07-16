import { Router } from "express";
import { requireAuthOrToken, requireAdmin } from "../../middleware/auth";
import { logger } from "./_helpers";
import { config } from "../../config";
import { isJellyfinMusicSource } from "../../services/jellyfin";
import { scanQueue } from "../../workers/queues";
import { organizeSingles } from "../../workers/organizeSingles";

const router = Router();

/**
 * @openapi
 * /library/scan:
 *   post:
 *     summary: Start a library scan job
 *     description: Initiates a background job to scan the music directory and index all audio files
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Library scan started successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Library scan started"
 *                 jobId:
 *                   type: string
 *                   description: Job ID to track progress
 *                   example: "123"
 *                 musicPath:
 *                   type: string
 *                   example: "/path/to/music"
 *       500:
 *         description: Failed to start scan
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/scan", async (req, res) => {
    try {
        if (await isJellyfinMusicSource()) {
            return res.status(400).json({
                error: "Library scan is not used when Jellyfin is the music source.",
                jellyfin: true,
            });
        }
        if (!config.music.musicPath) {
            return res.status(500).json({
                error: "Music path not configured. Please set MUSIC_PATH environment variable.",
            });
        }

        // Organize SLSKD downloads in background so the API responds immediately.
        // The scan job will run while organize runs; next scan will pick up any newly moved files.
        import("../../workers/organizeSingles")
            .then(({ organizeSingles }) => {
                logger.info("[Scan] Organizing SLSKD downloads in background...");
                return organizeSingles();
            })
            .then(() => logger.info("[Scan] SLSKD organization complete"))
            .catch((err: Error) =>
                logger.info("[Scan] SLSKD organization skipped:", err?.message)
            );

        const userId = req.user?.id || "system";

        // Add scan job to queue
        const job = await scanQueue.add("scan", {
            userId,
            musicPath: config.music.musicPath,
        });

        res.json({
            message: "Library scan started",
            jobId: job.id,
            musicPath: config.music.musicPath,
        });
    } catch (error) {
        logger.error("Scan trigger error:", error);
        res.status(500).json({ error: "Failed to start scan" });
    }
});

// GET /library/scan/status/:jobId - Check scan job status
router.get("/scan/status/:jobId", async (req, res) => {
    try {
        const job = await scanQueue.getJob(req.params.jobId);

        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }

        const state = await job.getState();
        const progress = job.progress;
        const result = job.returnvalue;

        res.json({
            status: state,
            progress,
            result,
            // Scan failures are thrown, so the reason lives on the job
            // rather than in the return value.
            error: state === "failed" ? job.failedReason : undefined,
        });
    } catch (error) {
        logger.error("Get scan status error:", error);
        res.status(500).json({ error: "Failed to get job status" });
    }
});

// POST /library/organize - Manually trigger organization script
router.post("/organize", async (req, res) => {
    try {
        // Run in background
        organizeSingles().catch((err) => {
            logger.error("Manual organization failed:", err);
        });

        res.json({ message: "Organization started in background" });
    } catch (error) {
        logger.error("Organization trigger error:", error);
        res.status(500).json({ error: "Failed to start organization" });
    }
});

/**
 * GET /library/jellyfin-metadata/status
 * Poll this to check if Jellyfin sync/enrich is running. Used by Sync New and Enrich button.
 */
router.get("/jellyfin-metadata/status", requireAuthOrToken, async (req, res) => {
    try {
        if (!(await isJellyfinMusicSource())) {
            return res.json({ status: "idle" as const });
        }
        const { getJobStatus } = await import("../../services/jellyfinMetadataJob");
        const state = await getJobStatus();
        return res.json(state);
    } catch (error: any) {
        logger.error("Jellyfin metadata status error:", error?.message || error);
        res.status(500).json({ error: "Failed to get status" });
    }
});

/**
 * POST /library/jellyfin-metadata/sync
 * Start Jellyfin track metadata sync + enrichment in the background. Returns immediately.
 * Poll GET /library/jellyfin-metadata/status for progress.
 */
router.post("/jellyfin-metadata/sync", requireAdmin, async (req, res) => {
    try {
        if (!(await isJellyfinMusicSource())) {
            return res.status(400).json({
                error: "Jellyfin metadata sync only applies when Jellyfin is the music source",
            });
        }
        const { runSyncAndEnrich } = await import("../../services/jellyfinMetadataJob");
        const { started, status } = await runSyncAndEnrich();
        if (!started) {
            return res.status(409).json({
                success: false,
                error: "Sync already in progress",
                status,
            });
        }
        return res.json({
            success: true,
            message: "Sync started. Poll /library/jellyfin-metadata/status for progress.",
            status,
        });
    } catch (error: any) {
        logger.error("Jellyfin metadata sync error:", error?.message || error);
        res.status(500).json({ error: "Failed to start Jellyfin metadata sync" });
    }
});

/**
 * POST /library/jellyfin-metadata/enrich
 * Start enrichment only (no sync) in the background. Returns immediately.
 * Poll GET /library/jellyfin-metadata/status for progress.
 */
router.post("/jellyfin-metadata/enrich", requireAdmin, async (req, res) => {
    try {
        if (!(await isJellyfinMusicSource())) {
            return res.status(400).json({
                error: "Jellyfin metadata enrichment only applies when Jellyfin is the music source",
            });
        }
        const { runEnrichOnly } = await import("../../services/jellyfinMetadataJob");
        const { started, status } = await runEnrichOnly();
        if (!started) {
            return res.status(409).json({
                success: false,
                error: "Enrichment already in progress",
                status,
            });
        }
        return res.json({
            success: true,
            message: "Enrichment started. Poll /library/jellyfin-metadata/status for progress.",
            status,
        });
    } catch (error: any) {
        logger.error("Jellyfin metadata enrich error:", error?.message || error);
        res.status(500).json({ error: "Failed to start Jellyfin metadata enrichment" });
    }
});

export default router;
