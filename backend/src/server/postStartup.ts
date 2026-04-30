import type { Express } from "express";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { dataCacheService } from "../services/dataCache";
import { requireAuth, requireAdmin } from "../middleware/auth";

/**
 * Run all post-listen startup tasks: dev tooling, music config init,
 * Bull Board admin dashboard (BullMQ), cache warmup, scheduled cleanups, and
 * background backfills.
 *
 * Each task is wrapped to be non-fatal on failure where possible —
 * the server should keep serving requests even if one backfill or
 * sync fails.
 */
export async function runPostStartupTasks(app: Express): Promise<void> {
    // Slow-query monitoring is dev-only.
    if (config.nodeEnv === "development") {
        const { enableSlowQueryMonitoring } = await import(
            "../utils/queryMonitor"
        );
        enableSlowQueryMonitoring();
    }

    // Music configuration reads from SystemSettings (DB).
    const { initializeMusicConfig } = await import("../config");
    await initializeMusicConfig();

    await mountBullBoard(app);

    logger.debug(
        "Background enrichment enabled for owned content (genres, MBIDs, etc.)"
    );

    // Warm up Redis cache from the DB so first page loads are instant
    // instead of waiting for cache population.
    dataCacheService.warmupCache().catch((err) => {
        logger.error("Cache warmup failed:", err);
    });

    schedulePodcastCacheCleanup();
    autoSyncAudiobooksIfEmpty();
    await reconcileDownloadQueue();
    // autoBackfillArtistCounts removed in Arch-X.d (denormalized
    // Artist counts dropped; counts are computed at read time).
    scheduleImageBackfill();
}

/**
 * Mount Bull Board (admin-only) for queue inspection. Workers run in a
 * separate process; the API only adds jobs to BullMQ queues.
 */
async function mountBullBoard(app: Express): Promise<void> {
    const { createBullBoard } = await import("@bull-board/api");
    const { BullMQAdapter } = await import("@bull-board/api/bullMQAdapter");
    const { ExpressAdapter } = await import("@bull-board/express");
    const { scanQueue, discoverQueue, imageQueue } = await import(
        "../workers/queues"
    );

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/api/admin/queues");

    createBullBoard({
        queues: [
            new BullMQAdapter(scanQueue),
            new BullMQAdapter(discoverQueue),
            new BullMQAdapter(imageQueue),
        ],
        serverAdapter,
    });

    app.use(
        "/api/admin/queues",
        requireAuth,
        requireAdmin,
        serverAdapter.getRouter()
    );
    logger.debug(
        "Bull Board dashboard available at /api/admin/queues (admin-only)"
    );
}

/**
 * Run podcast cache cleanup at startup and every 24h afterward. Cached
 * episodes older than 30 days are removed.
 */
function schedulePodcastCacheCleanup(): void {
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

    (async () => {
        const { cleanupExpiredCache } = await import(
            "../services/podcastDownload"
        );

        cleanupExpiredCache().catch((err) => {
            logger.error("Podcast cache cleanup failed:", err);
        });

        setInterval(() => {
            cleanupExpiredCache().catch((err) => {
                logger.error("Scheduled podcast cache cleanup failed:", err);
            });
        }, TWENTY_FOUR_HOURS);

        logger.debug("Podcast cache cleanup scheduled (daily, 30-day expiry)");
    })().catch((err) => {
        logger.error("Failed to schedule podcast cache cleanup:", err);
    });
}

/**
 * Auto-sync audiobooks on startup if cache is empty. Prevents
 * "disappeared" audiobooks after container rebuilds.
 */
function autoSyncAudiobooksIfEmpty(): void {
    (async () => {
        try {
            const { getSystemSettings } = await import(
                "../utils/systemSettings"
            );
            const settings = await getSystemSettings();

            if (
                settings?.audiobookshelfEnabled &&
                settings?.audiobookshelfUrl
            ) {
                const cachedCount = await prisma.audiobook.count();

                if (cachedCount === 0) {
                    logger.debug(
                        "[STARTUP] Audiobook cache is empty - auto-syncing from Audiobookshelf..."
                    );
                    const { audiobookCacheService } = await import(
                        "../services/audiobookCache"
                    );
                    const result = await audiobookCacheService.syncAll();
                    logger.debug(
                        `[STARTUP] Audiobook auto-sync complete: ${result.synced} audiobooks cached`
                    );
                } else {
                    logger.debug(
                        `[STARTUP] Audiobook cache has ${cachedCount} entries - skipping auto-sync`
                    );
                }
            }
        } catch (err) {
            logger.error("[STARTUP] Audiobook auto-sync failed:", err);
        }
    })();
}

/**
 * Reconcile the download queue with the DB so jobs that were active
 * before a restart are resumed (or marked failed if unrecoverable).
 */
async function reconcileDownloadQueue(): Promise<void> {
    const { downloadQueueManager } = await import("../services/downloadQueue");
    try {
        const result = await downloadQueueManager.reconcileOnStartup();
        logger.debug(
            `Download queue reconciled: ${result.loaded} active, ${result.failed} marked failed`
        );
    } catch (err) {
        logger.error("Download queue reconciliation failed:", err);
    }
}

/**
 * Schedule image backfill 3 minutes after startup to avoid contending with
 * other boot-time work (DB/network).
 */
function scheduleImageBackfill(): void {
    const IMAGE_BACKFILL_DELAY_MS = 3 * 60 * 1000;
    setTimeout(() => {
        (async () => {
            try {
                const { isImageBackfillNeeded, backfillAllImages } =
                    await import("../services/imageBackfill");
                const status = await isImageBackfillNeeded();
                if (status.needed) {
                    logger.info(
                        `[STARTUP] Image backfill needed: ${status.artistsWithExternalUrls} artists, ${status.albumsWithExternalUrls} albums with external URLs`
                    );
                    await backfillAllImages();
                    logger.info("[STARTUP] Image backfill complete");
                } else {
                    logger.debug("[STARTUP] All images already stored locally");
                }
            } catch (err) {
                logger.error("[STARTUP] Image backfill failed:", err);
            }
        })();
    }, IMAGE_BACKFILL_DELAY_MS);
}
