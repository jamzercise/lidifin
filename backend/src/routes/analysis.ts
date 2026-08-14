import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getSystemSettings } from "../utils/systemSettings";
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

const MAX_ANALYSIS_START_LIMIT = 1000;

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
        const [trackCounts, jellyfinCounts, queueLength] = await Promise.all([
            prisma.track.groupBy({
                by: ["analysisStatus"],
                _count: true,
            }),
            getJellyfinAudioAnalysisStatusCounts(),
            redisClient.lLen(ANALYSIS_QUEUE),
        ]);

        const { total, completed, failed, processing, pending } =
            combineAnalysisStatusCounts(trackCounts, jellyfinCounts);
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

export default router;
