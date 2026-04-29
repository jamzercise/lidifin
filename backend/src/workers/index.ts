import { logger } from "../utils/logger";
import {
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
} from "./queues";
import { processScan } from "./processors/scanProcessor";
import { processDiscoverWeekly } from "./processors/discoverProcessor";
import { processImageOptimization } from "./processors/imageProcessor";
import { processValidation } from "./processors/validationProcessor";
import {
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
} from "./unifiedEnrichment";
import {
    startMoodBucketWorker,
    stopMoodBucketWorker,
} from "./moodBucketWorker";
import { downloadQueueManager } from "../services/downloadQueue";
import { prisma } from "../utils/db";
import {
    startDiscoverWeeklyCron,
    stopDiscoverWeeklyCron,
} from "./discoverCron";
import { runDataIntegrityCheck } from "./dataIntegrity";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";
import { enrichmentStateService } from "../services/enrichmentState";
import { runSyncAndEnrich } from "../services/jellyfinMetadataJob";
import {
    startLibraryListCacheRefresh,
    stopLibraryListCacheRefresh,
    refreshAllOwnedAlbumsCache,
} from "../services/libraryListCache";

// Track intervals and timeouts for cleanup
const intervals: NodeJS.Timeout[] = [];
const timeouts: NodeJS.Timeout[] = [];

const OFFPEAK_START_HOUR = Math.max(
    0,
    Math.min(
        23,
        parseInt(process.env.MAINTENANCE_OFFPEAK_START_HOUR ?? "1", 10) || 1
    )
);
const OFFPEAK_END_HOUR = Math.max(
    0,
    Math.min(
        23,
        parseInt(process.env.MAINTENANCE_OFFPEAK_END_HOUR ?? "6", 10) || 6
    )
);
const IDLE_ACTIVITY_WINDOW_MINUTES = Math.max(
    5,
    parseInt(process.env.MAINTENANCE_IDLE_MINUTES ?? "20", 10) || 20
);

logger.debug(
    `[Maintenance] off-peak window ${OFFPEAK_START_HOUR}:00-${OFFPEAK_END_HOUR}:00, idle threshold ${IDLE_ACTIVITY_WINDOW_MINUTES}m`
);

function isWithinOffpeakWindow(date = new Date()): boolean {
    const hour = date.getHours();
    if (OFFPEAK_START_HOUR === OFFPEAK_END_HOUR) return true;
    if (OFFPEAK_START_HOUR < OFFPEAK_END_HOUR) {
        return hour >= OFFPEAK_START_HOUR && hour < OFFPEAK_END_HOUR;
    }
    return hour >= OFFPEAK_START_HOUR || hour < OFFPEAK_END_HOUR;
}

async function hasRecentUserActivity(
    minutes = IDLE_ACTIVITY_WINDOW_MINUTES
): Promise<boolean> {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const [recentPlayback, recentPlay] = await Promise.all([
        prisma.playbackState.findFirst({
            where: {
                trackId: { not: null },
                updatedAt: { gte: since },
            },
            select: { userId: true },
        }),
        prisma.play.findFirst({
            where: { playedAt: { gte: since } },
            select: { id: true },
            orderBy: { playedAt: "desc" },
        }),
    ]);
    return !!recentPlayback || !!recentPlay;
}

async function shouldRunHeavyMaintenance(taskName: string): Promise<boolean> {
    try {
        if (isWithinOffpeakWindow()) return true;
        const recentlyActive = await hasRecentUserActivity();
        if (!recentlyActive) return true;
        logger.debug(
            `[Maintenance] Deferring ${taskName} until off-peak/idle window`
        );
        return false;
    } catch (err) {
        logger.warn(
            `[Maintenance] Activity check failed for ${taskName}, running anyway`
        );
        return true;
    }
}

// Register processors with named job types
scanQueue.process("scan", processScan);
discoverQueue.process(processDiscoverWeekly);
imageQueue.process(processImageOptimization);
validationQueue.process(processValidation);

// Register download queue callback for unavailable albums
downloadQueueManager.onUnavailableAlbum(async (info) => {
    logger.debug(
        ` Recording unavailable album: ${info.artistName} - ${info.albumTitle}`
    );

    if (!info.userId) {
        logger.debug(` No userId provided, skipping database record`);
        return;
    }

    try {
        // Get week start date from discovery album if it exists
        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: { rgMbid: info.albumMbid },
            orderBy: { downloadedAt: "desc" },
        });

        await prisma.unavailableAlbum.create({
            data: {
                userId: info.userId,
                artistName: info.artistName,
                albumTitle: info.albumTitle,
                albumMbid: info.albumMbid,
                artistMbid: info.artistMbid,
                similarity: info.similarity || 0,
                tier: info.tier || "unknown",
                weekStartDate: discoveryAlbum?.weekStartDate || new Date(),
                attemptNumber: 0,
            },
        });

        logger.debug(`   Recorded in database`);
    } catch (error: any) {
        // Handle duplicate entries (album already marked as unavailable)
        if (error.code === "P2002") {
            logger.debug(`     Album already marked as unavailable`);
        } else {
            logger.error(
                ` Failed to record unavailable album:`,
                error.message
            );
        }
    }
});

// Start unified enrichment worker
// Handles: artist metadata, track tags (Last.fm), audio analysis queueing (Essentia)
startUnifiedEnrichmentWorker().catch((err) => {
    logger.error("Failed to start unified enrichment worker:", err);
});

// Start mood bucket worker only when Prisma is music source (Jellyfin has no local analyzed tracks)
(async () => {
    try {
        const { isJellyfinMusicSource } = await import("../services/jellyfin");
        if (await isJellyfinMusicSource()) {
            logger.debug("Mood bucket worker skipped – Jellyfin is music source, no local analyzed tracks");
        } else {
            await startMoodBucketWorker();
        }
    } catch (err) {
        logger.error("Failed to start mood bucket worker:", err);
    }
})();

// Precomputed Prisma album-list cache – only used when Prisma is music source
(async () => {
    try {
        const { isJellyfinMusicSource } = await import("../services/jellyfin");
        if (await isJellyfinMusicSource()) {
            logger.debug("Library list cache refresh skipped – Jellyfin is music source");
        } else {
            startLibraryListCacheRefresh();
            await refreshAllOwnedAlbumsCache();
        }
    } catch (err) {
        logger.warn("Initial library list cache refresh failed:", err);
    }
})();

// Jellyfin track metadata sync + enrichment (for By Vibe radio when Jellyfin is music source)
(async () => {
    try {
        const { isJellyfinMusicSource } = await import("../services/jellyfin");
        if (!(await isJellyfinMusicSource())) {
            logger.debug("Jellyfin metadata sync skipped – Jellyfin is not music source");
            return;
        }
        const { refreshJellyfinRgMbidCache } = await import(
            "../services/jellyfinMetadataSync"
        );

        const runRgMbidCacheRefresh = async (label: string) => {
            try {
                await refreshJellyfinRgMbidCache();
                logger.debug(`[JellyfinMetadata] ${label}: rgMbid cache refresh complete`);
            } catch (err: any) {
                logger.warn(
                    `[JellyfinMetadata] ${label}: rgMbid cache refresh failed:`,
                    err?.message
                );
            }
        };

        const runHeavyMetadataPass = async (label: string) => {
            const shouldRun = await shouldRunHeavyMaintenance(
                `Jellyfin metadata ${label}`
            );
            if (!shouldRun) return;
            try {
                const result = await runSyncAndEnrich();
                if (!result.started) {
                    logger.debug(
                        `[JellyfinMetadata] ${label}: job already ${result.status}, skipping`
                    );
                    return;
                }
                logger.debug(`[JellyfinMetadata] ${label}: started background sync/enrich`);
            } catch (err: any) {
                logger.warn(
                    `[JellyfinMetadata] ${label}: background sync/enrich failed to start:`,
                    err?.message
                );
            }
        };

        // Run sync 30s after startup (allow Jellyfin to be ready)
        timeouts.push(
            setTimeout(async () => {
                await runRgMbidCacheRefresh("startup");
                await runHeavyMetadataPass("startup");
            }, 30000)
        );
        // Schedule periodic sync every 6 hours
        intervals.push(
            setInterval(async () => {
                await runRgMbidCacheRefresh("periodic");
                await runHeavyMetadataPass("periodic");
            }, 6 * 60 * 60 * 1000)
        );
        logger.debug(
            "Jellyfin metadata maintenance scheduled (rgMbid cache refresh every 6h, heavy sync/enrich on off-peak/idle)"
        );
    } catch (err) {
        logger.warn("Jellyfin metadata sync setup failed:", err);
    }
})();

// Event handlers for scan queue
scanQueue.on("completed", (job, result) => {
    logger.debug(
        `Scan job ${job.id} completed: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved}`
    );
    refreshAllOwnedAlbumsCache().catch((err) => {
        logger.warn("Library list cache refresh after scan failed:", err);
    });
});

scanQueue.on("failed", (job, err) => {
    logger.error(`Scan job ${job.id} failed:`, err.message);
});

scanQueue.on("active", (job) => {
    logger.debug(` Scan job ${job.id} started`);
});

// Event handlers for discover queue
discoverQueue.on("completed", (job, result) => {
    if (result.success) {
        logger.debug(
            `Discover job ${job.id} completed: ${result.playlistName} (${result.songCount} songs)`
        );
    } else {
        logger.debug(`Discover job ${job.id} failed: ${result.error}`);
    }
});

discoverQueue.on("failed", (job, err) => {
    logger.error(`Discover job ${job.id} failed:`, err.message);
});

discoverQueue.on("active", (job) => {
    logger.debug(` Discover job ${job.id} started for user ${job.data.userId}`);
});

// Event handlers for image queue
imageQueue.on("completed", (job, result) => {
    logger.debug(
        `Image job ${job.id} completed: ${
            result.success ? "success" : result.error
        }`
    );
});

imageQueue.on("failed", (job, err) => {
    logger.error(`Image job ${job.id} failed:`, err.message);
});

// Event handlers for validation queue
validationQueue.on("completed", (job, result) => {
    logger.debug(
        `Validation job ${job.id} completed: ${result.tracksChecked} checked, ${result.tracksRemoved} removed`
    );
});

validationQueue.on("failed", (job, err) => {
    logger.error(` Validation job ${job.id} failed:`, err.message);
});

validationQueue.on("active", (job) => {
    logger.debug(` Validation job ${job.id} started`);
});

logger.debug("Worker processors registered and event handlers attached");

// Start Discovery Weekly cron scheduler (Sundays at 8 PM)
startDiscoverWeeklyCron();

async function runDataIntegrityCheckWhenIdle(trigger: string): Promise<void> {
    const shouldRun = await shouldRunHeavyMaintenance(
        `data integrity check (${trigger})`
    );
    if (!shouldRun) {
        // Re-attempt in 1 hour so maintenance still happens regularly during low activity.
        timeouts.push(
            setTimeout(() => {
                runDataIntegrityCheckWhenIdle("deferred").catch((err) => {
                    logger.error("Deferred data integrity check failed:", err);
                });
            }, 60 * 60 * 1000)
        );
        return;
    }
    runDataIntegrityCheck().catch((err) => {
        logger.error("Data integrity check failed:", err);
    });
}

// Run data integrity check on startup and then every 24 hours
timeouts.push(
    setTimeout(() => {
        runDataIntegrityCheckWhenIdle("startup").catch((err) => {
            logger.error("Data integrity check scheduling failed:", err);
        });
    }, 10000) // Run 10 seconds after startup
);

intervals.push(
    setInterval(() => {
        runDataIntegrityCheckWhenIdle("periodic").catch((err) => {
            logger.error("Data integrity check scheduling failed:", err);
        });
    }, 24 * 60 * 60 * 1000) // Run every 24 hours
);

logger.debug("Data integrity check scheduled (every 24 hours, off-peak/idle-aware)");

/**
 * Wrap an async operation with a timeout to prevent indefinite hangs
 * Returns undefined if the operation times out (does not throw)
 */
async function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    operationName: string
): Promise<T | undefined> {
    let timeoutId: NodeJS.Timeout | undefined;
    let timedOut = false;

    const timeoutPromise = new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => {
            timedOut = true;
            logger.warn(
                `Operation timed out after ${timeoutMs}ms: ${operationName}`
            );
            resolve(undefined);
        }, timeoutMs);
    });

    try {
        const result = await Promise.race([operation(), timeoutPromise]);
        if (!timedOut && timeoutId) {
            clearTimeout(timeoutId);
        }
        return result;
    } catch (error) {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        throw error;
    }
}

// Self-rescheduling reconciliation cycle (replaces setInterval to prevent pile-up)
// Each cycle waits for the previous one to fully complete before scheduling the next.
// This prevents zombie operations from accumulating when operations exceed their timeout.
async function runReconciliationCycle() {
    try {
        const shouldRun = await shouldRunHeavyMaintenance(
            "download reconciliation cycle"
        );
        if (!shouldRun) {
            timeouts.push(setTimeout(runReconciliationCycle, 5 * 60 * 1000));
            return;
        }
        const { lidarrService } = await import("../services/lidarr");
        if (!(await lidarrService.isEnabled())) {
            logger.debug("Reconciliation skipped – Lidarr not configured");
            timeouts.push(setTimeout(runReconciliationCycle, 2 * 60 * 1000));
            return;
        }
        const snapshot = await withTimeout(
            () => lidarrService.getReconciliationSnapshot(),
            30000,
            "getReconciliationSnapshot"
        );

        const staleCount = await withTimeout(
            () => simpleDownloadManager.markStaleJobsAsFailed(snapshot),
            120000,
            "markStaleJobsAsFailed"
        );
        if (staleCount && staleCount > 0) {
            logger.debug(
                `Periodic cleanup: marked ${staleCount} stale download(s) as failed`
            );
        }

        const lidarrResult = await withTimeout(
            () => simpleDownloadManager.reconcileWithLidarr(snapshot),
            120000,
            "reconcileWithLidarr"
        );
        if (lidarrResult && lidarrResult.reconciled > 0) {
            logger.debug(
                `Periodic reconcile: ${lidarrResult.reconciled} job(s) matched in Lidarr`
            );
        }

        const localResult = await withTimeout(
            () => queueCleaner.reconcileWithLocalLibrary(),
            120000,
            "reconcileWithLocalLibrary"
        );
        if (localResult && localResult.reconciled > 0) {
            logger.debug(
                `Periodic reconcile: ${localResult.reconciled} job(s) matched in local library`
            );
        }

        const syncResult = await withTimeout(
            () => simpleDownloadManager.syncWithLidarrQueue(snapshot),
            120000,
            "syncWithLidarrQueue"
        );
        if (syncResult && syncResult.cancelled > 0) {
            logger.debug(
                `Periodic sync: ${syncResult.cancelled} job(s) synced with Lidarr queue`
            );
        }
    } catch (err) {
        logger.error(
            "Periodic download cleanup/reconciliation failed:",
            err
        );
    }

    // Schedule next run AFTER this one completes (prevents pile-up)
    timeouts.push(setTimeout(runReconciliationCycle, 2 * 60 * 1000));
}

// First reconciliation run 2 minutes after startup
timeouts.push(setTimeout(runReconciliationCycle, 2 * 60 * 1000));
logger.debug("Stale download cleanup scheduled (every 2 minutes, self-rescheduling)");

// Self-rescheduling Lidarr queue cleanup (replaces setInterval to prevent pile-up)
async function runLidarrCleanupCycle() {
    try {
        const shouldRun = await shouldRunHeavyMaintenance(
            "lidarr queue cleanup cycle"
        );
        if (!shouldRun) {
            timeouts.push(setTimeout(runLidarrCleanupCycle, 10 * 60 * 1000));
            return;
        }
        const { lidarrService } = await import("../services/lidarr");
        if (!(await lidarrService.isEnabled())) {
            logger.debug("Lidarr queue cleanup skipped – Lidarr not configured");
            timeouts.push(setTimeout(runLidarrCleanupCycle, 5 * 60 * 1000));
            return;
        }
        const result = await withTimeout(
            () => simpleDownloadManager.clearLidarrQueue(),
            180000,
            "clearLidarrQueue"
        );
        if (result && result.removed > 0) {
            logger.debug(
                `Periodic Lidarr cleanup: removed ${result.removed} stuck download(s)`
            );
        }
    } catch (err) {
        logger.error("Lidarr queue cleanup failed:", err);
    }

    // Schedule next run AFTER this one completes (prevents pile-up)
    timeouts.push(setTimeout(runLidarrCleanupCycle, 5 * 60 * 1000));
}

// First Lidarr cleanup 5 minutes after startup (initial cleanup at 30s is separate)
timeouts.push(setTimeout(runLidarrCleanupCycle, 5 * 60 * 1000));
logger.debug("Lidarr queue cleanup scheduled (every 5 minutes, self-rescheduling)");

// Run initial Lidarr cleanup 30 seconds after startup (to catch any stuck items)
timeouts.push(
    setTimeout(async () => {
        try {
            logger.debug("Running initial Lidarr queue cleanup...");
            const result = await simpleDownloadManager.clearLidarrQueue();
            if (result.removed > 0) {
                logger.debug(
                    `Initial cleanup: removed ${result.removed} stuck download(s)`
                );
            } else {
                logger.debug("Initial cleanup: queue is clean");
            }
        } catch (err) {
            logger.error("Initial Lidarr cleanup failed:", err);
        }
    }, 30 * 1000) // 30 seconds after startup
);

/**
 * Gracefully shutdown all workers and cleanup resources
 */
export async function shutdownWorkers(): Promise<void> {
    logger.debug("Shutting down workers...");

    // Stop unified enrichment worker
    stopUnifiedEnrichmentWorker();

    // Disconnect enrichment state service Redis connections (2 connections)
    try {
        await enrichmentStateService.disconnect();
        logger.debug("Enrichment state service disconnected");
    } catch (err) {
        logger.error("Failed to disconnect enrichment state service:", err);
    }

    // Stop mood bucket worker
    stopMoodBucketWorker();

    stopLibraryListCacheRefresh();

    // Stop discover weekly cron
    stopDiscoverWeeklyCron();

    // Shutdown download queue manager
    downloadQueueManager.shutdown();

    // Clear all intervals
    for (const interval of intervals) {
        clearInterval(interval);
    }
    intervals.length = 0;

    // Clear all timeouts
    for (const timeout of timeouts) {
        clearTimeout(timeout);
    }
    timeouts.length = 0;

    // Remove all event listeners to prevent memory leaks
    scanQueue.removeAllListeners();
    discoverQueue.removeAllListeners();
    imageQueue.removeAllListeners();
    validationQueue.removeAllListeners();

    // Close all queues gracefully
    await Promise.all([
        scanQueue.close(),
        discoverQueue.close(),
        imageQueue.close(),
        validationQueue.close(),
    ]);

    logger.debug("Workers shutdown complete");
}

// Export queues for use in other modules
export { scanQueue, discoverQueue, imageQueue, validationQueue };
