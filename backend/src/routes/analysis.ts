import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getSystemSettings } from "../utils/systemSettings";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import {
    findByJellyfinTrackId,
    getAudioAnalysisStatusCounts as getJellyfinAudioAnalysisStatusCounts,
} from "../services/jellyfinTrackAnalysisService";
import {
    combineAnalysisStatusCounts,
    isJellyfinTrackId,
    mapJellyfinAnalysisToApiPayload,
} from "./analysisRouteHelpers";
import os from "os";

const router = Router();

// Redis queue key for audio analysis
const ANALYSIS_QUEUE = "audio:analysis:queue";
const VIBE_QUEUE = "audio:clap:queue";

const MAX_ANALYSIS_START_LIMIT = 1000;
const MAX_VIBE_START_LIMIT = 2000;

/** Reject internal endpoints if INTERNAL_API_SECRET is not configured (security) */
function requireInternalSecret(
    req: { headers: Record<string, string | string[] | undefined> },
    res: { status: (n: number) => { json: (o: object) => void } }
): boolean {
    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret || secret.length === 0) {
        logger.warn("[Analysis] INTERNAL_API_SECRET not set - rejecting internal request");
        res.status(503).json({
            error: "Service misconfigured (internal API secret not set)",
        });
        return false;
    }
    const provided = req.headers["x-internal-secret"];
    const providedStr = Array.isArray(provided) ? provided[0] : provided;
    if (providedStr !== secret) {
        res.status(403).json({ error: "Forbidden" });
        return false;
    }
    return true;
}

/** Coerce positive integer and cap to max (for limit params) */
function clampLimit(value: unknown, defaultVal: number, max: number): number {
    if (value === undefined || value === null) return defaultVal;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 1) return defaultVal;
    return Math.min(Math.floor(n), max);
}

/**
 * GET /api/analysis/status
 * Get audio analysis status and progress
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        // Aggregate counts from BOTH analysis tables — the legacy
        // `Track`-backed pipeline (local files) AND the Jellyfin-keyed
        // `JellyfinTrackAnalysis` table from X.b.1. Until X.d removes the
        // legacy columns, both can hold rows in mixed deployments and the
        // status dashboard should reflect the full picture.
        const [trackCounts, jellyfinCounts, queueLength, embeddingCount] =
            await Promise.all([
                prisma.track.groupBy({
                    by: ["analysisStatus"],
                    _count: true,
                }),
                getJellyfinAudioAnalysisStatusCounts(),
                redisClient.lLen(ANALYSIS_QUEUE),
                prisma.$queryRaw<{ count: bigint }[]>`
                    SELECT COUNT(*) as count FROM track_embeddings
                `,
            ]);

        const { total, completed, failed, processing, pending } =
            combineAnalysisStatusCounts(trackCounts, jellyfinCounts);
        const withEmbeddings = Number(embeddingCount[0]?.count || 0);
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

        res.json({
            total,
            completed,
            failed,
            processing,
            pending,
            queueLength,
            progress,
            isComplete: pending === 0 && processing === 0 && queueLength === 0,
            clap: {
                withEmbeddings,
                embeddingProgress:
                    total > 0
                        ? Math.round((withEmbeddings / total) * 100)
                        : 0,
            },
        });
    } catch (error: any) {
        logger.error("Analysis status error:", error);
        res.status(500).json({ error: "Failed to get analysis status" });
    }
});

/**
 * POST /api/analysis/start
 * Start audio analysis for pending tracks (admin only)
 */
router.post("/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const limit = clampLimit(req.body?.limit, 100, MAX_ANALYSIS_START_LIMIT);
        const priority =
            req.body?.priority === "title" || req.body?.priority === "recent"
                ? req.body.priority
                : "recent";

        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "pending",
            },
            select: {
                id: true,
                filePath: true,
                duration: true,
            },
            orderBy: priority === "recent"
                ? { fileModified: "desc" }
                : { title: "asc" },
            take: limit,
        });

        if (tracks.length === 0) {
            return res.json({
                message: "No pending tracks to analyze",
                queued: 0,
            });
        }

        // Queue tracks for analysis
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rPush(ANALYSIS_QUEUE, JSON.stringify({
                trackId: track.id,
                filePath: track.filePath,
                duration: track.duration,
            }));
        }
        await pipeline.exec();

        logger.debug(`Queued ${tracks.length} tracks for audio analysis`);

        res.json({
            message: `Queued ${tracks.length} tracks for analysis`,
            queued: tracks.length,
        });
    } catch (error: any) {
        logger.error("Analysis start error:", error);
        res.status(500).json({ error: "Failed to start analysis" });
    }
});

/**
 * POST /api/analysis/retry-failed
 * Retry failed analysis jobs (admin only)
 */
router.post("/retry-failed", requireAuth, requireAdmin, async (req, res) => {
    try {
        // Reset failed tracks to pending
        const result = await prisma.track.updateMany({
            where: {
                analysisStatus: "failed",
            },
            data: {
                analysisStatus: "pending",
                analysisError: null,
            },
        });

        res.json({
            message: `Reset ${result.count} failed tracks to pending`,
            reset: result.count,
        });
    } catch (error: any) {
        logger.error("Retry failed error:", error);
        res.status(500).json({ error: "Failed to retry analysis" });
    }
});

/**
 * POST /api/analysis/analyze/:trackId
 * Queue a specific track for analysis
 */
router.post("/analyze/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                id: true,
                filePath: true,
                duration: true,
                analysisStatus: true,
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Queue for analysis
        await redisClient.rPush(ANALYSIS_QUEUE, JSON.stringify({
            trackId: track.id,
            filePath: track.filePath,
            duration: track.duration,
        }));

        // Mark as pending if not already
        if (track.analysisStatus !== "processing") {
            await prisma.track.update({
                where: { id: trackId },
                data: { analysisStatus: "pending" },
            });
        }

        res.json({
            message: "Track queued for analysis",
            trackId,
        });
    } catch (error: any) {
        logger.error("Analyze track error:", error);
        res.status(500).json({ error: "Failed to queue track for analysis" });
    }
});

/**
 * GET /api/analysis/track/:trackId
 * Get analysis data for a specific track
 */
router.get("/track/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;

        // Dispatch on id namespace. Jellyfin tracks live on
        // `JellyfinTrackAnalysis` (X.b.1); legacy local-files tracks
        // remain on `Track` until X.d removes those columns.
        if (isJellyfinTrackId(trackId)) {
            const analysis = await findByJellyfinTrackId(trackId).catch(
                (err) => {
                    if (
                        err instanceof Error &&
                        err.message.startsWith(
                            "jellyfinTrackId must be in"
                        )
                    ) {
                        return null;
                    }
                    throw err;
                }
            );
            if (!analysis) {
                return res.status(404).json({ error: "Track not found" });
            }
            return res.json(mapJellyfinAnalysisToApiPayload(analysis));
        }

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            select: {
                id: true,
                title: true,
                analysisStatus: true,
                analysisError: true,
                analyzedAt: true,
                analysisVersion: true,
                analysisMode: true,
                bpm: true,
                beatsCount: true,
                key: true,
                keyScale: true,
                keyStrength: true,
                energy: true,
                loudness: true,
                dynamicRange: true,
                danceability: true,
                valence: true,
                arousal: true,
                instrumentalness: true,
                acousticness: true,
                speechiness: true,
                // MusiCNN mood predictions
                moodHappy: true,
                moodSad: true,
                moodRelaxed: true,
                moodAggressive: true,
                moodParty: true,
                moodAcoustic: true,
                moodElectronic: true,
                moodTags: true,
                essentiaGenres: true,
                lastfmTags: true,
            },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        res.json(track);
    } catch (error: any) {
        logger.error("Get track analysis error:", error);
        res.status(500).json({ error: "Failed to get track analysis" });
    }
});

/**
 * GET /api/analysis/features
 * Get aggregated feature statistics for the library
 */
router.get("/features", requireAuth, async (req, res) => {
    try {
        // Sample analyzed tracks (cap to avoid loading 100k+ rows and blocking event loop)
        const FEATURES_SAMPLE_CAP = 20_000;
        const analyzed = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                bpm: { not: null },
            },
            select: {
                bpm: true,
                energy: true,
                danceability: true,
                valence: true,
                keyScale: true,
            },
            orderBy: { id: "asc" }, // Deterministic so stats are stable across requests
            take: FEATURES_SAMPLE_CAP,
        });

        if (analyzed.length === 0) {
            return res.json({
                count: 0,
                averages: null,
                distributions: null,
            });
        }

        // Calculate averages
        const avgBpm = analyzed.reduce((sum, t) => sum + (t.bpm || 0), 0) / analyzed.length;
        const avgEnergy = analyzed.reduce((sum, t) => sum + (t.energy || 0), 0) / analyzed.length;
        const avgDanceability = analyzed.reduce((sum, t) => sum + (t.danceability || 0), 0) / analyzed.length;
        const avgValence = analyzed.reduce((sum, t) => sum + (t.valence || 0), 0) / analyzed.length;

        // Key distribution
        const majorCount = analyzed.filter(t => t.keyScale === "major").length;
        const minorCount = analyzed.filter(t => t.keyScale === "minor").length;

        // BPM distribution (buckets)
        const bpmBuckets = {
            slow: analyzed.filter(t => (t.bpm || 0) < 90).length,
            moderate: analyzed.filter(t => (t.bpm || 0) >= 90 && (t.bpm || 0) < 120).length,
            upbeat: analyzed.filter(t => (t.bpm || 0) >= 120 && (t.bpm || 0) < 150).length,
            fast: analyzed.filter(t => (t.bpm || 0) >= 150).length,
        };

        res.json({
            count: analyzed.length,
            averages: {
                bpm: Math.round(avgBpm),
                energy: Math.round(avgEnergy * 100) / 100,
                danceability: Math.round(avgDanceability * 100) / 100,
                valence: Math.round(avgValence * 100) / 100,
            },
            distributions: {
                key: { major: majorCount, minor: minorCount },
                bpm: bpmBuckets,
            },
        });
    } catch (error: any) {
        logger.error("Get features error:", error);
        res.status(500).json({ error: "Failed to get feature statistics" });
    }
});

/**
 * GET /api/analysis/workers
 * Get current audio analyzer worker configuration
 */
router.get("/workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.audioAnalyzerWorkers || 2;
        
        // Recommended: 50% of CPU cores, min 2, max 8
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));
        
        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            description: `Using ${currentWorkers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Get workers config error:", error);
        res.status(500).json({ error: "Failed to get worker configuration" });
    }
});

/**
 * PUT /api/analysis/workers
 * Update audio analyzer worker count
 */
router.put("/workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { workers } = req.body;
        
        if (typeof workers !== 'number' || workers < 1 || workers > 8) {
            return res.status(400).json({ 
                error: "Workers must be a number between 1 and 8" 
            });
        }
        
        // Update SystemSettings
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { audioAnalyzerWorkers: workers },
        });
        
        // Publish control signal to Redis for Python worker to pick up
        await redisClient.publish(
            "audio:analysis:control",
            JSON.stringify({ command: "set_workers", count: workers })
        );
        
        const cpuCores = os.cpus().length;
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));
        
        logger.info(`Audio analyzer workers updated to ${workers}`);
        
        res.json({
            workers,
            cpuCores,
            recommended,
            description: `Using ${workers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Update workers config error:", error);
        res.status(500).json({ error: "Failed to update worker configuration" });
    }
});

/**
 * GET /api/analysis/clap-workers
 * Get current CLAP analyzer worker configuration
 */
router.get("/clap-workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.clapWorkers || 2;

        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            description: `Using ${currentWorkers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Get CLAP workers config error:", error);
        res.status(500).json({ error: "Failed to get CLAP worker configuration" });
    }
});

/**
 * PUT /api/analysis/clap-workers
 * Update CLAP analyzer worker count
 */
router.put("/clap-workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { workers } = req.body;

        if (typeof workers !== 'number' || workers < 1 || workers > 8) {
            return res.status(400).json({
                error: "CLAP workers must be a number between 1 and 8"
            });
        }

        // Update SystemSettings
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { clapWorkers: workers },
        });

        // Publish control signal to Redis for CLAP analyzer to pick up
        await redisClient.publish(
            "audio:clap:control",
            JSON.stringify({ command: "set_workers", count: workers })
        );

        const cpuCores = os.cpus().length;
        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        logger.info(`CLAP analyzer workers updated to ${workers}`);

        res.json({
            workers,
            cpuCores,
            recommended,
            description: `Using ${workers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Update CLAP workers config error:", error);
        res.status(500).json({ error: "Failed to update CLAP worker configuration" });
    }
});

/**
 * POST /api/analysis/vibe/failure
 * Record a vibe embedding failure (called by CLAP analyzer)
 */
router.post("/vibe/failure", async (req, res) => {
    if (!requireInternalSecret(req, res)) return;

    try {
        const { trackId, trackName, errorMessage, errorCode } = req.body;

        if (typeof trackId !== "string" || trackId.length === 0 || trackId.length > 100) {
            return res.status(400).json({ error: "Valid trackId is required" });
        }

        await enrichmentFailureService.recordFailure({
            entityType: "vibe",
            entityId: trackId,
            entityName: trackName,
            errorMessage: errorMessage || "Vibe embedding generation failed",
            errorCode: errorCode,
        });

        res.json({ message: "Failure recorded" });
    } catch (error: any) {
        logger.error("Record vibe failure error:", error);
        res.status(500).json({ error: "Failed to record failure" });
    }
});

/**
 * POST /api/analysis/vibe/start
 * Queue tracks for vibe embedding generation (admin only)
 *
 * @param force - If true, delete all embeddings and re-queue all tracks
 */
router.post("/vibe/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const limit = clampLimit(req.body?.limit, 500, MAX_VIBE_START_LIMIT);
        const force = Boolean(req.body?.force);

        if (force) {
            await prisma.$executeRaw`DELETE FROM track_embeddings`;
            await enrichmentFailureService.clearAllFailures("vibe");
            logger.info("Cleared all vibe embeddings for re-generation");
        }

        const tracks = await prisma.$queryRaw<{ id: string; filePath: string; duration: number; title: string }[]>`
            SELECT t.id, t."filePath", t.duration, t.title
            FROM "Track" t
            LEFT JOIN track_embeddings te ON t.id = te.track_id
            WHERE te.track_id IS NULL
            AND t."filePath" IS NOT NULL
            ORDER BY t."fileModified" DESC
            LIMIT ${limit}
        `;

        if (tracks.length === 0) {
            return res.json({
                message: "All tracks have vibe embeddings",
                queued: 0,
            });
        }

        // Queue tracks for CLAP embedding
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rPush(VIBE_QUEUE, JSON.stringify({
                trackId: track.id,
                filePath: track.filePath,
                duration: track.duration,
            }));
        }
        await pipeline.exec();

        // Clear any existing vibe failures for these tracks
        for (const track of tracks) {
            await enrichmentFailureService.clearFailure("vibe", track.id);
        }

        logger.info(`Queued ${tracks.length} tracks for vibe embedding${force ? " (force reset)" : ""}`);

        res.json({
            message: `Queued ${tracks.length} tracks for vibe embedding`,
            queued: tracks.length,
        });
    } catch (error: any) {
        logger.error("Start vibe embedding error:", error);
        res.status(500).json({ error: "Failed to start vibe embedding" });
    }
});

/**
 * POST /api/analysis/vibe/retry
 * Retry failed vibe embeddings (admin only)
 */
router.post("/vibe/retry", requireAuth, requireAdmin, async (req, res) => {
    try {
        // Get all vibe failures
        const { failures } = await enrichmentFailureService.getFailures({
            entityType: "vibe",
            includeSkipped: false,
            includeResolved: false,
        });

        if (failures.length === 0) {
            return res.json({
                message: "No vibe failures to retry",
                queued: 0,
            });
        }

        // Get track details for failed tracks
        const trackIds = failures.map(f => f.entityId);
        const tracks = await prisma.track.findMany({
            where: { id: { in: trackIds } },
            select: { id: true, filePath: true, duration: true, title: true },
        });

        // Queue for retry
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rPush(VIBE_QUEUE, JSON.stringify({
                trackId: track.id,
                filePath: track.filePath,
                duration: track.duration,
            }));
        }
        await pipeline.exec();

        // Reset retry counts
        await enrichmentFailureService.resetRetryCount(failures.map(f => f.id));

        logger.info(`Retrying ${tracks.length} failed vibe embeddings`);

        res.json({
            message: `Queued ${tracks.length} failed tracks for vibe embedding retry`,
            queued: tracks.length,
        });
    } catch (error: any) {
        logger.error("Retry vibe failures error:", error);
        res.status(500).json({ error: "Failed to retry vibe failures" });
    }
});

/**
 * POST /api/analysis/vibe/success
 * Resolve failure records when a vibe embedding succeeds (called by CLAP analyzer)
 */
router.post("/vibe/success", async (req, res) => {
    if (!requireInternalSecret(req, res)) return;

    try {
        const trackId = req.body?.trackId;
        if (typeof trackId !== "string" || trackId.length === 0 || trackId.length > 100) {
            return res.status(400).json({ error: "Valid trackId is required" });
        }

        // Resolve any stale failure records for this track
        await enrichmentFailureService.resolveByEntity("vibe", trackId);

        res.json({ message: "Stale failures resolved" });
    } catch (error: any) {
        logger.error("Resolve vibe failure error:", error);
        res.status(500).json({ error: "Failed to resolve failures" });
    }
});

export default router;
