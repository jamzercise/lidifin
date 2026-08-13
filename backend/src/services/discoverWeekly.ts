/**
 * Discovery Weekly Service (Refactored)
 *
 * Generates weekly discovery playlists using Last.fm recommendations,
 * downloads via Lidarr, and only shows songs after successful import.
 *
 * Key improvements:
 * - Prisma transactions for atomic operations
 * - Pre-fetched and cached recommendations
 * - Structured logging with batch logs field
 * - No dynamic imports
 */

import { logger } from "../utils/logger";
import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import axios from "axios";
import { lastFmService } from "./lastfm";
import { musicBrainzService } from "./musicbrainz";
import { lidarrService } from "./lidarr";
import { scanQueue } from "../workers/queues";
import { startOfWeek, subWeeks } from "date-fns";
import { getSystemSettings } from "../utils/systemSettings";
import { discoveryLogger } from "./discoveryLogger";
import { acquisitionService } from "./acquisitionService";
import {
    discoveryBatchLogger,
    discoveryAlbumLifecycle,
    discoverySeeding,
    openLibraryReader,
    type LibraryTrackRef,
} from "./discovery";
import { shuffleArray } from "../utils/shuffle";
import { config as appConfig } from "../config";

interface SeedArtist {
    name: string;
    mbid?: string;
}

interface RecommendedAlbum {
    artistName: string;
    artistMbid?: string;
    albumTitle: string;
    albumMbid: string;
    similarity: number;
    tier?: "high" | "medium" | "explore" | "wildcard";
}

/**
 * A single recommended song for track-first Discover mode (ADR 0007).
 * albumTitle/trackMbid are best-effort hints used to improve Soulseek matching.
 */
interface RecommendedTrack {
    artistName: string;
    artistMbid?: string;
    trackTitle: string;
    albumTitle?: string;
    trackMbid?: string;
    similarity: number;
    tier?: "high" | "medium" | "explore" | "wildcard";
}

// Tier distribution for variety in recommendations
// This ensures each playlist has a mix of similarity levels
const TIER_DISTRIBUTION = {
    high: 0.3, // 30% from very similar artists (>80% match)
    medium: 0.4, // 40% from moderately similar (50-80% match)
    explore: 0.2, // 20% from stretch picks (30-50% match)
    wildcard: 0.1, // 10% from genre tags (variety)
};

interface BatchLogEntry {
    timestamp: string;
    level: "info" | "warn" | "error";
    message: string;
}

/**
 * Calculate tier from Last.fm similarity score
 * Last.fm typically returns scores in 0.5-0.9 range for similar artists
 * Adjusted thresholds for better distribution:
 * - High Match: 60-100% (0.6-1.0)
 * - Medium Match: 45-59% (0.45-0.59)
 * - Explore: 30-44% (0.3-0.44)
 * - Wild Card: 0-29% (0-0.29) or explicitly set
 */
function getTierFromSimilarity(
    similarity: number
): "high" | "medium" | "explore" | "wildcard" {
    if (similarity >= 0.6) return "high";
    if (similarity >= 0.45) return "medium";
    if (similarity >= 0.3) return "explore";
    return "wildcard";
}

export class DiscoverWeeklyService {
    /**
     * Main entry: Generate Discovery Weekly
     */
    async generatePlaylist(userId: string, jobId?: number) {
        // Start a dedicated log file for this generation
        const logPath = discoveryLogger.start(userId, jobId);
        discoveryLogger.info(`Log file: ${logPath}`);

        try {
            discoveryLogger.section("CONFIGURATION CHECK");
            const settings = await getSystemSettings();

            const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });

            // Get user config
            const config = await prisma.userDiscoverConfig.findUnique({
                where: { userId },
            });

            if (!config || !config.enabled) {
                discoveryLogger.error("Discovery Weekly not enabled for user");
                discoveryLogger.end(false, "Not enabled");
                throw new Error("Discovery Weekly not enabled");
            }

            // Get download ratio from config (default 1.3)
            const downloadRatio = config.downloadRatio ?? 1.3;

            discoveryLogger.table({
                "Target Songs": config.playlistSize,
                "Download Ratio": `${downloadRatio}x`,
                "Week Start": weekStart.toISOString().split("T")[0],
            });

            // CRITICAL: Process previous week's liked albums before generating new ones
            discoveryLogger.section("PROCESSING PREVIOUS WEEK");
            await discoveryAlbumLifecycle.processBeforeGeneration(userId, settings);

            const targetCount = config.playlistSize;

            // Step 1: Get seed artists
            discoveryLogger.section("STEP 1: SEED ARTISTS");
            const seeds = await discoverySeeding.getSeedArtists(userId);
            if (seeds.length === 0) {
                discoveryLogger.error(
                    "No seed artists found - need listening history"
                );
                discoveryLogger.end(false, "No seed artists");
                throw new Error(
                    "No seed artists found - need listening history"
                );
            }
            discoveryLogger.success(`Found ${seeds.length} seed artists:`);
            discoveryLogger.list(
                seeds.map(
                    (s) => `${s.name}${s.mbid ? ` (${s.mbid})` : " (no MBID)"}`
                )
            );

            // Step 2: Pre-fetch and cache similar artists (parallel with rate limiting)
            discoveryLogger.section("STEP 2: SIMILAR ARTISTS");
            const similarArtistsMap = await this.prefetchSimilarArtists(seeds);
            discoveryLogger.success(
                `Cached ${similarArtistsMap.size} similar artist sets`
            );
            for (const [key, similar] of similarArtistsMap.entries()) {
                const seedName =
                    seeds.find((s) => s.mbid === key || s.name === key)?.name ||
                    key;
                discoveryLogger.write(
                    `  ${seedName}: ${similar.length} similar artists`,
                    1
                );
            }

            // ADR 0007: track-first mode downloads individual songs instead of
            // full albums. Branch here once seeds + similar artists are ready so
            // the album path below stays completely unchanged.
            if (config.acquisitionMode === "track") {
                return await this.generateTrackPlaylist({
                    userId,
                    weekStart,
                    settings,
                    targetCount,
                    downloadRatio,
                    seeds,
                    similarArtistsMap,
                });
            }

            // Step 3: Find recommended albums using multi-strategy discovery
            // REQUEST MORE ALBUMS than target to account for download failures
            // User configurable ratio (default 1.3x) to control bandwidth usage
            const albumsToRequest = Math.ceil(targetCount * downloadRatio);

            discoveryLogger.section(
                "STEP 3: ALBUM RECOMMENDATIONS (Multi-Strategy)"
            );
            discoveryLogger.info(
                `Requesting ${albumsToRequest} albums (${downloadRatio}x target of ${targetCount}) to account for failures`
            );

            const recommended = await this.findRecommendedAlbumsMultiStrategy(
                seeds,
                similarArtistsMap,
                albumsToRequest, // Request more albums!
                userId
            );

            if (recommended.length === 0) {
                discoveryLogger.error(
                    "No recommendations found after filtering"
                );
                discoveryLogger.end(false, "No recommendations found");
                throw new Error("No recommendations found");
            }

            // MINIMUM THRESHOLD CHECK: Ensure we have enough candidates
            // We need at least targetCount albums, ideally more for variety
            const minRecommendations = targetCount;
            if (recommended.length < minRecommendations) {
                discoveryLogger.warn(
                    `Only ${recommended.length} recommendations found, need at least ${minRecommendations} for ${targetCount} unique albums`
                );
                discoveryLogger.warn(
                    "Consider expanding seed artists or playing more music"
                );
                await discoveryBatchLogger.warn(
                    "threshold-check",
                    `Low recommendations: ${recommended.length}/${minRecommendations} minimum (target: ${targetCount} unique albums)`
                );
            }

            discoveryLogger.success(
                `${recommended.length} albums recommended for download`
            );
            discoveryLogger.list(
                recommended.map(
                    (r) =>
                        `${r.artistName} - ${r.albumTitle} (similarity: ${(
                            r.similarity * 100
                        ).toFixed(0)}%)`
                )
            );

            // Step 4: Create batch and jobs in a transaction
            discoveryLogger.section("STEP 4: CREATE BATCH & JOBS");

            // Get music path from settings (already fetched at line 276) with fallback to app config
            const musicPath = settings?.musicPath || appConfig.music.musicPath;

            const batch = await prisma.$transaction(async (tx) => {
                // Create discovery batch
                const newBatch = await tx.discoveryBatch.create({
                    data: {
                        userId,
                        weekStart,
                        targetSongCount: targetCount,
                        status: "downloading",
                        totalAlbums: recommended.length,
                        completedAlbums: 0,
                        failedAlbums: 0,
                        logs: [
                            {
                                timestamp: new Date().toISOString(),
                                level: "info",
                                message: `Started with ${recommended.length} albums to download`,
                            },
                        ] as any,
                    },
                });
                discoveryLogger.success(`Created batch: ${newBatch.id}`);

                // Create all download jobs in the same transaction
                for (const album of recommended) {
                    // Ensure similarity is a valid number
                    const similarity =
                        typeof album.similarity === "number" &&
                        !isNaN(album.similarity)
                            ? album.similarity
                            : 0.5;

                    // Check for existing pending/processing job to avoid duplicates
                    const existingJob = await tx.downloadJob.findFirst({
                        where: {
                            targetMbid: album.albumMbid,
                            status: { in: ["pending", "processing"] },
                        },
                    });

                    if (existingJob) {
                        logger.debug(
                            `   Skipping job: ${album.artistName} - ${album.albumTitle} (already in queue: ${existingJob.id})`
                        );
                        continue;
                    }

                    logger.debug(
                        `   Creating job: ${album.artistName} - ${album.albumTitle} (similarity: ${similarity}, tier: ${album.tier})`
                    );

                    await tx.downloadJob.create({
                        data: {
                            userId,
                            subject: `${album.artistName} - ${album.albumTitle}`,
                            type: "album",
                            targetMbid: album.albumMbid,
                            status: "pending",
                            discoveryBatchId: newBatch.id,
                            metadata: {
                                downloadType: "discovery",
                                rootFolderPath: musicPath,
                                artistName: album.artistName,
                                artistMbid: album.artistMbid,
                                albumTitle: album.albumTitle,
                                albumMbid: album.albumMbid,
                                similarity: similarity,
                                tier: album.tier,
                            },
                        },
                    });
                }

                return newBatch;
            });
            discoveryLogger.success(
                `Created ${recommended.length} download jobs`
            );

            // Step 5: Start downloads outside transaction (they involve external APIs)
            discoveryLogger.section("STEP 5: START DOWNLOADS");
            let downloadsStarted = 0;
            let downloadsFailed = 0;

            const jobs = await prisma.downloadJob.findMany({
                where: { discoveryBatchId: batch.id },
            });
    
            // Create concurrent acquisition promises
            const acquisitionPromises = jobs.map(async (job) => {
                const metadata = job.metadata as any;
    
                discoveryLogger.info(
                    `Acquiring: ${metadata.artistName} - ${metadata.albumTitle}`,
                    1
                );
    
                const result = await acquisitionService.acquireAlbum(
                    {
                        albumTitle: metadata.albumTitle,
                        artistName: metadata.artistName,
                        mbid: metadata.albumMbid,
                        lastfmUrl: undefined,
                    },
                    {
                        userId: userId,
                        discoveryBatchId: batch.id,
                        existingJobId: job.id,
                    }
                );
    
                if (result.success) {
                    discoveryLogger.success(
                        `Acquired via ${result.source}: ${metadata.artistName} - ${metadata.albumTitle}`,
                        1
                    );
    
                    const newStatus = result.source === "soulseek" ? "completed" : "processing";
                    // NOTE: Do NOT write `lidarrRef` here. For the Lidarr path the
                    // job's correlationId is already stored by startDownload, and
                    // `lidarrRef` must stay null so the Lidarr "Grab" webhook can
                    // adopt the job and populate it with the real download client
                    // ID. Overwriting it with the correlationId previously made
                    // discovery jobs invisible to webhook matching and left them
                    // stuck in `processing` forever.
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: newStatus,
                            completedAt: newStatus === "completed" ? new Date() : null,
                        },
                    });
                } else {
                    discoveryLogger.error(
                        `Failed to acquire: ${metadata.albumTitle} - ${result.error}`,
                        1
                    );
    
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "failed",
                            error: result.error,
                            completedAt: new Date(),
                        },
                    });
    
                    await discoveryBatchLogger.error(
                        batch.id,
                        `Failed to acquire ${metadata.albumTitle}: ${result.error}`
                    );
                }
    
                return { job, result };
            });
    
            // Execute all acquisitions concurrently
            const results = await Promise.allSettled(acquisitionPromises);
    
            // Process results and update counters
            for (let index = 0; index < results.length; index++) {
                const settledResult = results[index];
                if (settledResult.status === 'fulfilled') {
                    const { result } = settledResult.value;
                    if (result.success) {
                        downloadsStarted++;
                    } else {
                        downloadsFailed++;
                    }
                } else {
                    downloadsFailed++;
                    const job = jobs[index];
                    const metadata = job.metadata as any;
                    const reason =
                        settledResult.reason instanceof Error
                            ? settledResult.reason.message
                            : String(settledResult.reason);
                    logger.error(`[Discover] Failed to acquire ${metadata.albumTitle}: ${reason}`);
                    // The acquire threw before reaching a status update — mark the
                    // job failed so it can't get stuck in `pending` forever.
                    await prisma.downloadJob
                        .update({
                            where: { id: job.id },
                            data: {
                                status: "failed",
                                error: reason,
                                completedAt: new Date(),
                            },
                        })
                        .catch((e) =>
                            logger.error(
                                `[Discover] Could not mark job ${job.id} as failed: ${e}`
                            )
                        );
                }
            }
    
            // Log batch completion summary
            logger.info(`[Discover] Batch complete: ${downloadsStarted} succeeded, ${downloadsFailed} failed`);

            // After all download attempts, check if batch should be completed
            // This handles cases where downloads fail before webhooks are triggered
            if (downloadsStarted === 0 || downloadsFailed > 0) {
                logger.debug(`[Discovery] Checking batch completion (started: ${downloadsStarted}, failed: ${downloadsFailed})`);
                await this.checkBatchCompletion(batch.id);
            }

            discoveryLogger.section("GENERATION COMPLETE");
            discoveryLogger.table({
                "Downloads Started": downloadsStarted,
                "Downloads Failed": downloadsFailed,
                "Total Albums": recommended.length,
                "Batch ID": batch.id,
            });

            await discoveryBatchLogger.info(
                batch.id,
                `${downloadsStarted} downloads started, waiting for webhooks`
            );

            discoveryLogger.end(
                true,
                `${downloadsStarted}/${recommended.length} downloads queued`
            );

            return {
                success: true,
                playlistName: `Discover Weekly (Week of ${weekStart.toLocaleDateString()})`,
                songCount: 0,
                batchId: batch.id,
            };
        } catch (error: any) {
            discoveryLogger.error(`Generation failed: ${error.message}`);
            discoveryLogger.end(false, error.message);
            throw error;
        }
    }

    /**
     * Track-first generation path (ADR 0007).
     *
     * Recommends individual songs, creates one `type: "track"` DownloadJob per
     * song, and acquires them all via a single Soulseek batch. Downloaded files
     * land on disk synchronously, so jobs are marked completed/failed up-front
     * and {@link checkBatchCompletion} kicks off the scan → buildFinalPlaylist
     * chain (which branches on `batch.mode`).
     */
    private async generateTrackPlaylist(params: {
        userId: string;
        weekStart: Date;
        settings: any;
        targetCount: number;
        downloadRatio: number;
        seeds: SeedArtist[];
        similarArtistsMap: Map<string, any[]>;
    }) {
        const {
            userId,
            weekStart,
            settings,
            targetCount,
            downloadRatio,
            seeds,
            similarArtistsMap,
        } = params;

        const tracksToRequest = Math.ceil(targetCount * downloadRatio);
        discoveryLogger.section("STEP 3: TRACK RECOMMENDATIONS (Track-First)");
        discoveryLogger.info(
            `Requesting ${tracksToRequest} tracks (${downloadRatio}x target of ${targetCount})`
        );

        const recommended = await this.findRecommendedTracksMultiStrategy(
            seeds,
            similarArtistsMap,
            tracksToRequest,
            userId
        );

        if (recommended.length === 0) {
            discoveryLogger.error("No track recommendations found");
            discoveryLogger.end(false, "No track recommendations found");
            throw new Error("No recommendations found");
        }

        discoveryLogger.success(
            `${recommended.length} tracks recommended for download`
        );
        discoveryLogger.list(
            recommended.map(
                (r) =>
                    `${r.artistName} - ${r.trackTitle} (${(
                        r.similarity * 100
                    ).toFixed(0)}%)`
            )
        );

        const musicPath = settings?.musicPath || appConfig.music.musicPath;

        // Step 4: create batch + one DownloadJob per recommended track
        discoveryLogger.section("STEP 4: CREATE BATCH & TRACK JOBS");
        const batch = await prisma.$transaction(async (tx) => {
            const newBatch = await tx.discoveryBatch.create({
                data: {
                    userId,
                    weekStart,
                    mode: "track",
                    targetSongCount: targetCount,
                    status: "downloading",
                    totalAlbums: recommended.length,
                    completedAlbums: 0,
                    failedAlbums: 0,
                    logs: [
                        {
                            timestamp: new Date().toISOString(),
                            level: "info",
                            message: `Started with ${recommended.length} tracks to download (track-first mode)`,
                        },
                    ] as any,
                },
            });

            for (const track of recommended) {
                const similarity =
                    typeof track.similarity === "number" &&
                    !isNaN(track.similarity)
                        ? track.similarity
                        : 0.5;
                // Last.fm rarely returns track MBIDs; synthesize a stable, unique
                // targetMbid so the (required) column stays populated + distinct.
                const targetMbid =
                    track.trackMbid ||
                    `track:${track.artistName}:${track.trackTitle}`
                        .toLowerCase()
                        .slice(0, 180);

                await tx.downloadJob.create({
                    data: {
                        userId,
                        subject: `${track.artistName} - ${track.trackTitle}`,
                        type: "track",
                        targetMbid,
                        status: "pending",
                        discoveryBatchId: newBatch.id,
                        metadata: {
                            downloadType: "discovery",
                            mode: "track",
                            rootFolderPath: musicPath,
                            artistName: track.artistName,
                            artistMbid: track.artistMbid,
                            trackTitle: track.trackTitle,
                            albumTitle: track.albumTitle,
                            trackMbid: track.trackMbid,
                            similarity,
                            tier: track.tier,
                        },
                    },
                });
            }
            return newBatch;
        });
        discoveryLogger.success(
            `Created batch ${batch.id} with ${recommended.length} track jobs`
        );

        // Step 5: acquire every track through a single Soulseek batch
        discoveryLogger.section("STEP 5: DOWNLOAD TRACKS (Soulseek)");
        const jobs = await prisma.downloadJob.findMany({
            where: { discoveryBatchId: batch.id },
        });

        const requests = jobs.map((job) => {
            const m = job.metadata as any;
            return {
                trackTitle: m.trackTitle as string,
                artistName: m.artistName as string,
                albumTitle: (m.albumTitle as string) || undefined,
            };
        });

        let downloadsStarted = 0;
        let downloadsFailed = 0;

        try {
            // results map 1:1 to requests (same order as jobs)
            const results = await acquisitionService.acquireTracks(requests, {
                userId,
                discoveryBatchId: batch.id,
            });

            for (let i = 0; i < jobs.length; i++) {
                const job = jobs[i];
                const result = results[i];
                if (result?.success) {
                    downloadsStarted++;
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: { status: "completed", completedAt: new Date() },
                    });
                } else {
                    downloadsFailed++;
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "failed",
                            error: result?.error || "Track download failed",
                            completedAt: new Date(),
                        },
                    });
                }
            }
        } catch (err: any) {
            discoveryLogger.error(
                `Track batch download failed: ${err.message}`
            );
            await prisma.downloadJob.updateMany({
                where: { discoveryBatchId: batch.id, status: "pending" },
                data: {
                    status: "failed",
                    error: err.message,
                    completedAt: new Date(),
                },
            });
            downloadsFailed = jobs.length;
        }

        logger.info(
            `[Discover] Track batch complete: ${downloadsStarted} succeeded, ${downloadsFailed} failed`
        );

        // Scan imported files and assemble the playlist (mode-aware build)
        await this.checkBatchCompletion(batch.id);

        discoveryLogger.section("GENERATION COMPLETE");
        discoveryLogger.table({
            "Tracks Downloaded": downloadsStarted,
            "Tracks Failed": downloadsFailed,
            "Total Tracks": recommended.length,
            "Batch ID": batch.id,
        });
        discoveryLogger.end(
            true,
            `${downloadsStarted}/${recommended.length} tracks downloaded`
        );

        return {
            success: true,
            playlistName: `Discover Weekly (Week of ${weekStart.toLocaleDateString()})`,
            songCount: 0,
            batchId: batch.id,
        };
    }

    /**
     * Pre-fetch similar artists for all seeds (parallel with rate limiting)
     * Now includes exponential backoff retry for API failures
     */
    private async prefetchSimilarArtists(
        seeds: SeedArtist[]
    ): Promise<Map<string, any[]>> {
        const cache = new Map<string, any[]>();

        // Helper: fetch with exponential backoff retry
        const fetchWithRetry = async (
            seed: SeedArtist,
            maxRetries = 3
        ): Promise<any[]> => {
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                try {
                    const similar = await lastFmService.getSimilarArtists(
                        seed.mbid || "",
                        seed.name,
                        20
                    );
                    return similar;
                } catch (error: any) {
                    const isRetryable =
                        error.response?.status === 429 ||
                        error.response?.status >= 500 ||
                        error.code === "ECONNRESET" ||
                        error.code === "ETIMEDOUT";

                    if (isRetryable && attempt < maxRetries) {
                        const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
                        logger.warn(
                            `   Retry ${attempt}/${maxRetries} for ${seed.name} in ${delay}ms (${error.message})`
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }

                    logger.warn(
                        `   Failed to get similar artists for ${seed.name}: ${error.message}`
                    );
                    return [];
                }
            }
            return [];
        };

        // Process seeds in smaller batches to avoid overwhelming APIs
        const batchSize = 3;
        for (let i = 0; i < seeds.length; i += batchSize) {
            const seedBatch = seeds.slice(i, i + batchSize);

            const results = await Promise.all(
                seedBatch.map(async (seed) => {
                    const similar = await fetchWithRetry(seed);
                    return { key: seed.mbid || seed.name, similar };
                })
            );

            for (const { key, similar } of results) {
                cache.set(key, similar);
            }

            // Small delay between batches
            if (i + batchSize < seeds.length) {
                await new Promise((r) => setTimeout(r, 300));
            }
        }

        return cache;
    }

    /**
     * Cancel the user's active discovery batch. Marks any still-running jobs as
     * failed ("Cancelled by user") and closes the batch so the UI stops polling.
     */
    async cancelActiveBatch(
        userId: string
    ): Promise<{ success: boolean; error?: string; cancelledJobs?: number }> {
        const batch = await prisma.discoveryBatch.findFirst({
            where: { userId, status: { in: ["downloading", "scanning"] } },
            orderBy: { createdAt: "desc" },
        });

        if (!batch) {
            return { success: false, error: "No active generation to cancel" };
        }

        const result = await prisma.downloadJob.updateMany({
            where: {
                discoveryBatchId: batch.id,
                status: { in: ["pending", "processing"] },
            },
            data: {
                status: "failed",
                error: "Cancelled by user",
                completedAt: new Date(),
            },
        });

        await prisma.discoveryBatch.update({
            where: { id: batch.id },
            data: {
                status: "completed",
                completedAt: new Date(),
                errorMessage: "Cancelled by user",
            },
        });

        await discoveryBatchLogger
            .info(batch.id, `Batch cancelled by user (${result.count} job(s) stopped)`)
            .catch(() => {});

        return { success: true, cancelledJobs: result.count };
    }

    /**
     * Retry a single failed discovery album by re-running acquisition for its
     * existing DownloadJob. Reactivates the parent batch so completion tracking
     * picks it back up.
     */
    async retryAlbumJob(
        userId: string,
        jobId: string
    ): Promise<{ success: boolean; error?: string }> {
        const job = await prisma.downloadJob.findFirst({
            where: { id: jobId, userId },
        });

        if (!job) {
            return { success: false, error: "Download job not found" };
        }

        const metadata = job.metadata as any;
        if (metadata?.downloadType !== "discovery") {
            return { success: false, error: "Not a discovery download" };
        }
        if (!metadata?.albumTitle || !metadata?.artistName) {
            return { success: false, error: "Missing album metadata for retry" };
        }

        // Reset the job and reactivate the batch so it's tracked again
        await prisma.downloadJob.update({
            where: { id: job.id },
            data: { status: "pending", error: null, completedAt: null },
        });
        if (job.discoveryBatchId) {
            await prisma.discoveryBatch
                .update({
                    where: { id: job.discoveryBatchId },
                    data: {
                        status: "downloading",
                        completedAt: null,
                        errorMessage: null,
                    },
                })
                .catch(() => {});
        }

        const result = await acquisitionService.acquireAlbum(
            {
                albumTitle: metadata.albumTitle,
                artistName: metadata.artistName,
                mbid: metadata.albumMbid,
                lastfmUrl: undefined,
            },
            {
                userId,
                discoveryBatchId: job.discoveryBatchId ?? undefined,
                existingJobId: job.id,
            }
        );

        if (result.success) {
            const newStatus =
                result.source === "soulseek" ? "completed" : "processing";
            await prisma.downloadJob.update({
                where: { id: job.id },
                data: {
                    status: newStatus,
                    completedAt: newStatus === "completed" ? new Date() : null,
                },
            });
        } else {
            await prisma.downloadJob.update({
                where: { id: job.id },
                data: {
                    status: "failed",
                    error: result.error,
                    completedAt: new Date(),
                },
            });
        }

        return { success: result.success, error: result.error };
    }

    /**
     * Remove failed/exhausted download jobs from the user's most recent batch so
     * they stop lingering in the Discover UI queue. Only clears terminal-failure
     * jobs; pending/processing/completed jobs are left untouched. If the batch is
     * still active and no in-flight jobs remain afterward, mark it completed so
     * the queue UI clears out instead of spinning forever.
     */
    async dismissFailedJobs(
        userId: string,
        batchId?: string
    ): Promise<{ success: boolean; error?: string; dismissed?: number }> {
        const batch = batchId
            ? await prisma.discoveryBatch.findFirst({
                  where: { id: batchId, userId },
                  include: { jobs: true },
              })
            : await prisma.discoveryBatch.findFirst({
                  where: { userId },
                  orderBy: { createdAt: "desc" },
                  include: { jobs: true },
              });

        if (!batch) {
            return { success: false, error: "No discovery batch found" };
        }

        const failedJobIds = batch.jobs
            .filter((j) => j.status === "failed" || j.status === "exhausted")
            .map((j) => j.id);

        if (failedJobIds.length === 0) {
            return { success: true, dismissed: 0 };
        }

        const result = await prisma.downloadJob.deleteMany({
            where: { id: { in: failedJobIds }, userId },
        });

        // If the batch is still "active" but nothing is in flight anymore,
        // close it out so the live queue stops showing as in-progress.
        const remaining = batch.jobs.filter(
            (j) => !failedJobIds.includes(j.id)
        );
        const stillRunning = remaining.some(
            (j) => j.status === "pending" || j.status === "processing"
        );
        if (
            !stillRunning &&
            (batch.status === "downloading" || batch.status === "scanning")
        ) {
            await prisma.discoveryBatch
                .update({
                    where: { id: batch.id },
                    data: { status: "completed", completedAt: new Date() },
                })
                .catch(() => {});
        }

        await discoveryBatchLogger
            .info(
                batch.id,
                `Dismissed ${result.count} failed job(s) from queue (user action)`
            )
            .catch(() => {});

        return { success: true, dismissed: result.count };
    }

    /**
     * Check for batches stuck in "downloading" or "scanning" status for too long
     * Called periodically from queue cleaner
     */
    async checkStuckBatches(): Promise<number> {
        const BATCH_TIMEOUT_WITH_COMPLETIONS = 30 * 60 * 1000; // 30 minutes
        const BATCH_TIMEOUT_NO_COMPLETIONS = 60 * 60 * 1000; // 60 minutes
        const ABSOLUTE_MAX_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours - force fail any batch older than this

        const stuckBatches = await prisma.discoveryBatch.findMany({
            where: {
                status: { in: ["downloading", "scanning"] },
            },
            include: { jobs: true },
        });

        let forcedCount = 0;

        for (const batch of stuckBatches) {
            const batchAge = Date.now() - batch.createdAt.getTime();
            const completedJobs = batch.jobs.filter(
                (j) => j.status === "completed"
            );
            const pendingJobs = batch.jobs.filter(
                (j) => j.status === "pending" || j.status === "processing"
            );

            // Absolute timeout - fail any batch older than 2 hours regardless of state
            if (batchAge > ABSOLUTE_MAX_TIMEOUT) {
                logger.debug(
                    `\n⏰ [BATCH FORCE FAIL] Batch ${batch.id} is ${Math.round(
                        batchAge / 3600000
                    )}h old - force failing`
                );

                await prisma.discoveryBatch.update({
                    where: { id: batch.id },
                    data: {
                        status: "failed",
                        errorMessage: "Batch timed out after 2 hours",
                        completedAt: new Date(),
                    },
                });

                // Mark any remaining pending/processing jobs as failed
                await prisma.downloadJob.updateMany({
                    where: {
                        discoveryBatchId: batch.id,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "failed",
                        error: "Batch force-failed due to timeout",
                        completedAt: new Date(),
                    },
                });

                forcedCount++;
                continue;
            }

            // If all jobs are done but batch is still "downloading", checkBatchCompletion
            // may have failed or never ran — retry it immediately
            if (pendingJobs.length === 0 && batch.status === "downloading") {
                logger.debug(
                    `\n🔧 [BATCH RECOVERY] Batch ${batch.id} stuck in "downloading" with 0 pending jobs — retrying completion`
                );
                await this.checkBatchCompletion(batch.id);
                forcedCount++;
                continue;
            }

            // If batch is stuck in "scanning" (buildFinalPlaylist failed), retry it
            if (pendingJobs.length === 0 && batch.status === "scanning" && batchAge > 5 * 60 * 1000) {
                logger.debug(
                    `\n🔧 [BATCH RECOVERY] Batch ${batch.id} stuck in "scanning" for ${Math.round(batchAge / 60000)}min — retrying playlist build`
                );
                try {
                    await this.buildFinalPlaylist(batch.id);
                } catch (err: any) {
                    logger.error(`   Retry buildFinalPlaylist failed: ${err.message}`);
                }
                forcedCount++;
                continue;
            }

            // Check if batch should be force-completed (pending jobs timed out)
            const hasCompletions = completedJobs.length > 0;
            const timeout = hasCompletions
                ? BATCH_TIMEOUT_WITH_COMPLETIONS
                : BATCH_TIMEOUT_NO_COMPLETIONS;

            if (batchAge > timeout && pendingJobs.length > 0) {
                logger.debug(
                    `\n⏰ [BATCH TIMEOUT] Batch ${
                        batch.id
                    } stuck for ${Math.round(batchAge / 60000)}min`
                );
                logger.debug(
                    `   Completed: ${completedJobs.length}, Pending: ${pendingJobs.length}`
                );

                // Mark all pending jobs as failed (timed out)
                await prisma.downloadJob.updateMany({
                    where: {
                        discoveryBatchId: batch.id,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "failed",
                        error: "Batch timeout - download took too long",
                        completedAt: new Date(),
                    },
                });

                logger.debug(
                    `   Marked ${pendingJobs.length} pending jobs as failed`
                );

                // Now trigger batch completion check
                await this.checkBatchCompletion(batch.id);
                forcedCount++;
            }
        }

        return forcedCount;
    }

    /**
     * Check if discovery batch is complete and trigger final steps
     */
    async checkBatchCompletion(batchId: string) {
        logger.debug(`\n[BATCH ${batchId}] Checking completion...`);

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: batchId },
            include: { jobs: true },
        });

        if (!batch) {
            logger.debug(`[BATCH ${batchId}] Not found - skipping`);
            return;
        }

        // Skip if already completed/failed/scanning
        if (
            batch.status === "completed" ||
            batch.status === "failed" ||
            batch.status === "scanning"
        ) {
            logger.debug(
                `[BATCH ${batchId}] Already ${batch.status} - skipping`
            );
            return;
        }

        const completedJobs = batch.jobs.filter(
            (j) => j.status === "completed"
        );
        const failedJobs = batch.jobs.filter(
            (j) => j.status === "failed" || j.status === "exhausted"
        );
        const pendingJobs = batch.jobs.filter(
            (j) => j.status === "pending" || j.status === "processing"
        );

        const completed = completedJobs.length;
        const failed = failedJobs.length;
        const total = batch.jobs.length;

        logger.debug(
            `[BATCH ${batchId}] Status: ${completed} completed, ${failed} failed, ${pendingJobs.length} pending (total: ${total})`
        );

        // Wait for ALL downloads to complete/fail
        if (pendingJobs.length > 0) {
            logger.debug(
                `[BATCH ${batchId}] Still waiting for ${pendingJobs.length} downloads`
            );
            return;
        }

        // Wait for Lidarr to finish importing files
        logger.debug(`[BATCH ${batchId}] All jobs done! Waiting 60s for Lidarr to finish importing...`);
        await new Promise(resolve => setTimeout(resolve, 60000));
        logger.debug(`[BATCH ${batchId}] Transitioning to scan phase...`);

        // All jobs finished - use transaction to update batch and create unavailable records
        await prisma.$transaction(async (tx) => {
            // Create UnavailableAlbum records for failed downloads.
            // Skip in track-first mode: failed track jobs have synthetic MBIDs
            // and no album, so they'd pollute the "Hidden gems" shelf.
            for (const job of batch.mode === "track" ? [] : failedJobs) {
                const metadata = job.metadata as any;
                try {
                    await tx.unavailableAlbum.upsert({
                        where: {
                            userId_weekStartDate_albumMbid: {
                                userId: batch.userId,
                                weekStartDate: batch.weekStart,
                                albumMbid: job.targetMbid,
                            },
                        },
                        create: {
                            userId: batch.userId,
                            albumMbid: job.targetMbid,
                            artistName: metadata?.artistName || "Unknown",
                            albumTitle: metadata?.albumTitle || "Unknown",
                            similarity: metadata?.similarity || 0.5,
                            tier:
                                metadata?.tier ||
                                getTierFromSimilarity(
                                    metadata?.similarity || 0.5
                                ),
                            attemptNumber: 1,
                            weekStartDate: batch.weekStart,
                        },
                        update: {
                            attemptNumber: { increment: 1 },
                        },
                    });
                } catch (e) {
                    // Ignore duplicate errors
                }
            }

            // Update batch status
            if (completed === 0) {
                await tx.discoveryBatch.update({
                    where: { id: batchId },
                    data: {
                        status: "failed",
                        completedAlbums: 0,
                        failedAlbums: failed,
                        errorMessage: "All downloads failed",
                        completedAt: new Date(),
                    },
                });
            } else {
                await tx.discoveryBatch.update({
                    where: { id: batchId },
                    data: {
                        status: "scanning",
                        completedAlbums: completed,
                        failedAlbums: failed,
                    },
                });
            }
        });

        if (completed === 0) {
            logger.debug(`   All downloads failed`);
            await discoveryBatchLogger.error(batchId, "All downloads failed");

            // Cleanup failed artists from Lidarr
            await this.cleanupFailedArtists(batchId);
            return;
        }

        // All successful downloads will be included in the playlist
        logger.debug(
            `   ${completed} albums ready for playlist. Triggering scan...`
        );
        await discoveryBatchLogger.info(
            batchId,
            `${completed} completed, ${failed} failed. All successful downloads will be in playlist.`
        );

        // Trigger ONE scan with batch ID
        await scanQueue.add("scan", {
            type: "full",
            source: "discover-weekly-completion",
            discoveryBatchId: batchId,
        });

        logger.debug(
            `   Scan queued - will build playlist after scan completes`
        );
    }

    /**
     * Build final playlist after scan completes (atomic transaction)
     */
    async buildFinalPlaylist(batchId: string) {
        logger.debug(`\n Building final playlist for batch ${batchId}...`);

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: batchId },
        });

        if (!batch) {
            logger.debug(`   Batch not found`);
            return;
        }

        // Get completed download jobs
        const completedJobs = await prisma.downloadJob.findMany({
            where: {
                discoveryBatchId: batchId,
                status: "completed",
            },
        });

        logger.debug(`   Found ${completedJobs.length} completed downloads`);
        await discoveryBatchLogger.info(
            batchId,
            `Building playlist from ${completedJobs.length} completed downloads`
        );

        // Find tracks for completed jobs. Track-first mode (ADR 0007) matches
        // individual songs by title+artist; album mode matches whole albums.
        // Downloads have only just landed, and in Jellyfin mode the scan handoff
        // has only just indexed them, so this has to read the library as it is
        // now rather than any cached view of it.
        const library = await openLibraryReader({ fresh: true });
        if (library.isJellyfin && library.size === 0) {
            logger.warn(
                `   Jellyfin is the music source but no track metadata is stored, ` +
                    `so nothing downloaded for this batch can be matched. ` +
                    `Run the Jellyfin metadata sync from Settings.`
            );
        }

        let allTracks: LibraryTrackRef[] = [];

        if (batch.mode === "track") {
            // Track-first jobs name one song. They carry no album MBID, so the
            // album a track lands on is whatever the library says it is.
            const trackCriteria = completedJobs
                .map((job) => {
                    const m = job.metadata as any;
                    return {
                        artistName: (m?.artistName || "").trim(),
                        trackTitle: (m?.trackTitle || "").trim(),
                        albumTitle: (m?.albumTitle || "").trim() || undefined,
                    };
                })
                .filter((c) => c.artistName && c.trackTitle);

            allTracks = await library.findTracks(trackCriteria);
        } else {
            // Album jobs name a release, preferably by MBID.
            const searchCriteria = completedJobs
                .map((j) => {
                    const metadata = j.metadata as any;
                    return {
                        artistName: metadata?.artistName || "",
                        albumTitle: metadata?.albumTitle || "",
                        albumMbid: metadata?.albumMbid || j.targetMbid || "",
                    };
                })
                .filter((c) => c.artistName && c.albumTitle);

            logger.debug(
                `   Searching for tracks using MBID (primary) + name fallback:`
            );
            for (const c of searchCriteria) {
                logger.debug(
                    `     - "${c.albumTitle}" by "${c.artistName}" (MBID: ${
                        c.albumMbid || "none"
                    })`
                );
            }

            allTracks = await library.findAlbumTracks(searchCriteria);
        }

        // Remove duplicates (same track ID)
        const uniqueTracks = Array.from(
            new Map(allTracks.map((t) => [t.id, t])).values()
        );
        allTracks = uniqueTracks;

        logger.debug(`   Found ${allTracks.length} tracks from imported albums`);

        if (allTracks.length === 0) {
            const reason =
                library.isJellyfin && library.size === 0
                    ? "No tracks found after scan - no Jellyfin track metadata is stored, so run the Jellyfin metadata sync from Settings"
                    : "No tracks found after scan";
            logger.debug(`   ${reason}`);
            await prisma.discoveryBatch.update({
                where: { id: batchId },
                data: {
                    status: "failed",
                    errorMessage: reason,
                    completedAt: new Date(),
                },
            });
            await discoveryBatchLogger.error(batchId, reason);
            return;
        }

        // Album mode collapses to one random track per album for variety.
        // Track-first mode keeps every matched song (that IS the recommendation).
        let onePerAlbum: typeof allTracks = [];
        if (batch.mode === "track") {
            onePerAlbum = [...allTracks];
        } else {
            const tracksByAlbum = new Map<string, typeof allTracks>();
            for (const track of allTracks) {
                const albumId = track.album.id;
                if (!tracksByAlbum.has(albumId)) {
                    tracksByAlbum.set(albumId, []);
                }
                tracksByAlbum.get(albumId)!.push(track);
            }
            for (const [, tracks] of tracksByAlbum) {
                const randomTrack =
                    tracks[Math.floor(Math.random() * tracks.length)];
                onePerAlbum.push(randomTrack);
            }
        }

        const availableAlbums = onePerAlbum.length;
        const anchorCount = Math.ceil(availableAlbums * 0.2); // Add 20% anchors on top

        logger.debug(
            `   Unique albums available: ${availableAlbums} (from ${allTracks.length} total tracks)`
        );
        logger.debug(
            `   Target composition: ${availableAlbums} discovery + ${anchorCount} anchors = ${
                availableAlbums + anchorCount
            } total`
        );

        // Shuffle the unique album tracks
        const shuffled = shuffleArray(onePerAlbum);

        // Step 1: Get ALL discovery tracks (1 per album) - no limit!
        let discoverySelected = [...shuffled];
        logger.debug(
            `   Discovery tracks: ${discoverySelected.length} (ALL available, 1 per album)`
        );

        // Step 2: ALWAYS add library anchor tracks (20%)
        // Get seed artists for this user
        const seeds = await discoverySeeding.getSeedArtists(batch.userId);
        const seedArtistNames = seeds.slice(0, 10).map((s) => s.name);
        const seedArtistMbids = seeds
            .slice(0, 10)
            .map((s) => s.mbid)
            .filter(Boolean) as string[];

        let libraryAnchors: any[] = [];
        // Get existing track IDs to avoid duplicates
        const existingTrackIds = new Set(discoverySelected.map((t) => t.id));

        // First, try to find library tracks from seed artists (by name or mbid)
        // Also exclude albums already used in discovery
        const usedAlbumIds = new Set(discoverySelected.map((t) => t.album.id));

        if (seedArtistNames.length > 0 || seedArtistMbids.length > 0) {
            const seedAnchors = await library.findAnchorTracks({
                artistNames: seedArtistNames,
                artistMbids: seedArtistMbids,
                excludeTrackIds: existingTrackIds,
                excludeAlbumIds: usedAlbumIds,
                limit: anchorCount,
            });

            logger.debug(
                `   Found ${seedAnchors.length} candidate library tracks from ${seedArtistNames.length} seed artists`
            );

            libraryAnchors = shuffleArray(seedAnchors).slice(0, anchorCount);
            for (const track of libraryAnchors) {
                track.isLibraryAnchor = true;
                usedAlbumIds.add(track.album.id);
            }
        }

        // GUARANTEE: If we don't have enough anchors from seed artists, use ANY popular library tracks
        if (libraryAnchors.length < anchorCount) {
            const needed = anchorCount - libraryAnchors.length;
            logger.debug(
                `   Only ${libraryAnchors.length}/${anchorCount} anchors from seeds, adding ${needed} from popular library tracks`
            );

            // Get track IDs we already have (discovery + current anchors)
            const usedTrackIds = new Set([
                ...existingTrackIds,
                ...libraryAnchors.map((t) => t.id),
            ]);

            // Anywhere in the library will do at this point.
            const extraAnchors = await library.findAnchorTracks({
                excludeTrackIds: usedTrackIds,
                excludeAlbumIds: usedAlbumIds,
                limit: needed,
            });

            if (extraAnchors.length > 0) {
                const additionalAnchors = shuffleArray(extraAnchors).slice(
                    0,
                    needed
                );

                for (const track of additionalAnchors) {
                    track.isLibraryAnchor = true;
                    usedAlbumIds.add(track.album.id);
                }

                libraryAnchors = [...libraryAnchors, ...additionalAnchors];
                logger.debug(
                    `   Added ${additionalAnchors.length} popular library tracks as anchors (1 per album)`
                );
            } else {
                logger.debug(
                    `   No additional library tracks available for anchors`
                );
            }
        }

        logger.debug(
            `   Library anchors: ${libraryAnchors.length}/${anchorCount}`
        );

        // Combine ALL discovery tracks with anchors
        let selected = [...discoverySelected, ...libraryAnchors];

        // Shuffle the final selection to mix anchors with discovery
        selected = shuffleArray(selected);

        await discoveryBatchLogger.info(
            batchId,
            `Playlist built: ${discoverySelected.length} discovery + ${libraryAnchors.length} anchors = ${selected.length} total`
        );

        // Log final result
        const target = batch.targetSongCount; // For logging purposes only
        if (selected.length === 0) {
            logger.debug(`   FAILED: No tracks available for playlist`);
            await discoveryBatchLogger.error(
                batchId,
                `No tracks available for playlist`
            );
        } else if (selected.length < target) {
            logger.debug(
                `   NOTE: Got ${selected.length} tracks (target was ${target}, including ALL successful downloads)`
            );
            await discoveryBatchLogger.info(
                batchId,
                `Got ${selected.length} tracks (target was ${target})`
            );
        } else {
            logger.debug(
                `   SUCCESS: Got ${selected.length} tracks (${discoverySelected.length} discovery + ${libraryAnchors.length} anchors)`
            );
        }

        // Create discovery records in transaction
        let result: { albumCount: number; trackCount: number } | null = null;
        try {
            result = await prisma.$transaction(async (tx) => {
                const createdAlbums = new Map<string, string>();
                let trackCount = 0;

                for (const track of selected) {
                    // Use album ID as the key for deduplication (not MBID)
                    const albumKey = track.album.id;
                    let discoveryAlbumId = createdAlbums.get(albumKey);

                    if (!discoveryAlbumId) {
                        // Find the job for this album by artist+album name (case-insensitive)
                        const job = completedJobs.find((j) => {
                            const metadata = j.metadata as any;
                            const jobArtist = (metadata?.artistName || "")
                                .toLowerCase()
                                .trim();
                            const jobAlbum = (metadata?.albumTitle || "")
                                .toLowerCase()
                                .trim();
                            const jobTrack = (metadata?.trackTitle || "")
                                .toLowerCase()
                                .trim();
                            const trackArtist = track.album.artist.name
                                .toLowerCase()
                                .trim();
                            const trackAlbum = track.album.title
                                .toLowerCase()
                                .trim();
                            const trackTitle = (track.title || "")
                                .toLowerCase()
                                .trim();
                            // Album jobs match on artist+album; track-first jobs
                            // (no albumTitle) match on artist+track title.
                            return (
                                (jobArtist === trackArtist &&
                                    jobAlbum === trackAlbum) ||
                                (!!jobTrack &&
                                    jobArtist === trackArtist &&
                                    jobTrack === trackTitle)
                            );
                        });

                        const metadata = job?.metadata as any;

                        // Use upsert to handle regeneration (records may already exist)
                        // IMPORTANT: Use the tier from metadata directly, don't recalculate!
                        // This preserves "wildcard" and other tiers that don't match their similarity
                        const storedTier =
                            metadata?.tier ||
                            getTierFromSimilarity(metadata?.similarity || 0.5);
                        const storedSimilarity = metadata?.similarity || 0.5;

                        // Debug: Log if job wasn't matched
                        if (!job) {
                            logger.debug(
                                `   [WARN] No job match for: ${track.album.artist.name} - ${track.album.title}`
                            );
                            logger.debug(
                                `     Available jobs: ${completedJobs
                                    .map(
                                        (j) =>
                                            `${
                                                (j.metadata as any)?.artistName
                                            } - ${
                                                (j.metadata as any)?.albumTitle
                                            }`
                                    )
                                    .slice(0, 5)
                                    .join(", ")}...`
                            );
                        } else {
                            logger.debug(
                                `   ✓ Job matched: ${
                                    track.album.artist.name
                                } - ${
                                    track.album.title
                                } (tier: ${storedTier}, similarity: ${(
                                    storedSimilarity * 100
                                ).toFixed(0)}%)`
                            );
                        }

                        const discoveryAlbum = await tx.discoveryAlbum.upsert({
                            where: {
                                userId_weekStartDate_rgMbid: {
                                    userId: batch.userId,
                                    weekStartDate: batch.weekStart,
                                    rgMbid: track.album.rgMbid,
                                },
                            },
                            create: {
                                userId: batch.userId,
                                rgMbid: track.album.rgMbid,
                                artistName: track.album.artist.name,
                                artistMbid: track.album.artist.mbid,
                                albumTitle: track.album.title,
                                lidarrAlbumId: job?.lidarrAlbumId,
                                similarity: storedSimilarity,
                                tier: storedTier,
                                weekStartDate: batch.weekStart,
                                downloadedAt: new Date(),
                                status: "ACTIVE",
                            },
                            update: {
                                // Refresh data on regeneration
                                artistName: track.album.artist.name,
                                artistMbid: track.album.artist.mbid,
                                albumTitle: track.album.title,
                                lidarrAlbumId: job?.lidarrAlbumId,
                                similarity: storedSimilarity,
                                tier: storedTier,
                                downloadedAt: new Date(),
                                status: "ACTIVE", // Reset to active on regeneration
                            },
                        });

                        discoveryAlbumId = discoveryAlbum.id;
                        createdAlbums.set(albumKey, discoveryAlbumId);

                        // Add to exclusion list (if user has exclusions enabled)
                        const userConfig =
                            await tx.userDiscoverConfig.findUnique({
                                where: { userId: batch.userId },
                            });
                        const exclusionMonths =
                            userConfig?.exclusionMonths ?? 6;

                        if (exclusionMonths > 0) {
                            const expiresAt = new Date();
                            expiresAt.setMonth(
                                expiresAt.getMonth() + exclusionMonths
                            );

                            await tx.discoverExclusion.upsert({
                                where: {
                                    userId_albumMbid: {
                                        userId: batch.userId,
                                        albumMbid: track.album.rgMbid,
                                    },
                                },
                                create: {
                                    userId: batch.userId,
                                    albumMbid: track.album.rgMbid,
                                    artistName: track.album.artist.name,
                                    albumTitle: track.album.title,
                                    expiresAt,
                                },
                                update: {
                                    lastSuggestedAt: new Date(),
                                    expiresAt,
                                },
                            });
                        }
                    }

                    await tx.discoveryTrack.create({
                        data: {
                            discoveryAlbumId,
                            trackId: track.id,
                            fileName: track.filePath.split("/").pop() || "",
                            filePath: track.filePath,
                        },
                    });

                    trackCount++;
                }

                // Mark batch complete
                await tx.discoveryBatch.update({
                    where: { id: batchId },
                    data: {
                        status: "completed",
                        finalSongCount: trackCount,
                        completedAt: new Date(),
                    },
                });

                return { albumCount: createdAlbums.size, trackCount };
            });
        } catch (txError: any) {
            logger.error(`   ERROR: Transaction failed:`, txError.message);
            logger.error(`   Stack:`, txError.stack);
            await discoveryBatchLogger.error(
                batchId,
                `Transaction failed: ${txError.message}`
            );
        }

        if (result) {
            logger.debug(
                `   Playlist complete: ${result.trackCount} tracks from ${result.albumCount} albums`
            );
            await discoveryBatchLogger.info(
                batchId,
                `Playlist complete: ${result.trackCount} tracks from ${result.albumCount} albums`
            );
        } else {
            logger.error(
                `   ERROR: Transaction returned null - no records created`
            );
            await discoveryBatchLogger.error(
                batchId,
                "Transaction failed - no records created"
            );
        }

        // ALWAYS cleanup failed artists from Lidarr (even if playlist creation failed)
        // This prevents accumulating unused artists in Lidarr over time
        await this.cleanupFailedArtists(batchId);

        // Also cleanup any orphaned Lidarr queue items from this batch
        await this.cleanupOrphanedLidarrQueue(batchId);
    }

    /**
     * Reconcile Discovery Weekly tracks after library scans
     * Backfills Discovery Weekly playlists with tracks from albums that downloaded after initial playlist creation
     *
     * Similar to Spotify Import's reconcilePendingTracks(), but for Discovery Weekly:
     * - Finds completed batches from last 7 days
     * - Checks if their downloaded albums are in the library
     * - Creates DiscoveryAlbum + DiscoveryTrack records for missing albums
     */
    async reconcileDiscoveryTracks(): Promise<{
        batchesChecked: number;
        tracksAdded: number;
    }> {
        logger.debug(
            `\n[Discovery Weekly] Reconciling tracks across completed batches...`
        );

        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        // Find completed batches from last 7 days
        const completedBatches = await prisma.discoveryBatch.findMany({
            where: {
                status: "completed",
                completedAt: { gte: sevenDaysAgo },
            },
            orderBy: { completedAt: "desc" },
        });

        if (completedBatches.length === 0) {
            logger.debug(`   No completed batches in last 7 days to reconcile`);
            return { batchesChecked: 0, tracksAdded: 0 };
        }

        logger.debug(
            `   Found ${completedBatches.length} completed batch(es) from last 7 days`
        );

        // Reconciliation runs after a scan, so the library has just changed.
        const library = await openLibraryReader({ fresh: true });

        let totalTracksAdded = 0;
        let batchesChecked = 0;

        for (const batch of completedBatches) {
            // Track-first batches (ADR 0007) are assembled entirely by
            // buildFinalPlaylist via title+artist matching; album-centric
            // reconciliation doesn't apply.
            if (batch.mode === "track") {
                continue;
            }

            logger.debug(`   Checking batch ${batch.id}...`);
            batchesChecked++;

            // Get completed download jobs for this batch
            const completedJobs = await prisma.downloadJob.findMany({
                where: {
                    discoveryBatchId: batch.id,
                    status: "completed",
                },
            });

            if (completedJobs.length === 0) {
                logger.debug(`     No completed jobs in batch ${batch.id}`);
                continue;
            }

            logger.debug(
                `     Found ${completedJobs.length} completed download job(s)`
            );

            // Check each completed job to see if it has corresponding DiscoveryAlbum records
            for (const job of completedJobs) {
                const metadata = job.metadata as any;
                const albumMbid = metadata?.albumMbid || job.targetMbid;
                const artistName = metadata?.artistName;
                const albumTitle = metadata?.albumTitle;

                if (!albumMbid) {
                    logger.debug(
                        `     Skipping job ${job.id} - no album MBID`
                    );
                    continue;
                }

                // Check if this album already has DiscoveryAlbum record
                const existingDiscoveryAlbum =
                    await prisma.discoveryAlbum.findFirst({
                        where: {
                            userId: batch.userId,
                            weekStartDate: batch.weekStart,
                            rgMbid: albumMbid,
                        },
                    });

                if (existingDiscoveryAlbum) {
                    // Already has discovery record, skip
                    continue;
                }

                logger.debug(
                    `     Album "${albumTitle}" by "${artistName}" missing from Discovery - checking library...`
                );

                // Matched on the release MBID where possible, otherwise on the
                // artist and album names.
                const tracks = await library.findAlbumTracks([
                    {
                        artistName: artistName ?? "",
                        albumTitle: albumTitle ?? "",
                        albumMbid,
                    },
                ]);

                if (tracks.length === 0) {
                    logger.debug(
                        `       No tracks found in library - album may not have imported yet`
                    );
                    continue;
                }

                // Album is in library! Create DiscoveryAlbum + DiscoveryTrack records
                const album = tracks[0].album;
                const similarity = metadata?.similarity || 0.5;
                const tier =
                    metadata?.tier || getTierFromSimilarity(similarity);

                logger.debug(
                    `       ✓ Creating Discovery records for ${tracks.length} track(s)...`
                );

                try {
                    await prisma.$transaction(async (tx) => {
                        // Create DiscoveryAlbum
                        const discoveryAlbum = await tx.discoveryAlbum.create({
                            data: {
                                userId: batch.userId,
                                rgMbid: album.rgMbid,
                                artistName: album.artist.name,
                                artistMbid: album.artist.mbid,
                                albumTitle: album.title,
                                lidarrAlbumId: job.lidarrAlbumId,
                                similarity,
                                tier,
                                weekStartDate: batch.weekStart,
                                downloadedAt: new Date(),
                                status: "ACTIVE",
                            },
                        });

                        // Create DiscoveryTrack for each track
                        for (const track of tracks) {
                            // Check if track already exists (prevent duplicates)
                            const existingTrack =
                                await tx.discoveryTrack.findFirst({
                                    where: {
                                        discoveryAlbumId: discoveryAlbum.id,
                                        trackId: track.id,
                                    },
                                });

                            if (!existingTrack) {
                                await tx.discoveryTrack.create({
                                    data: {
                                        discoveryAlbumId: discoveryAlbum.id,
                                        trackId: track.id,
                                        fileName:
                                            track.filePath.split("/").pop() ||
                                            "",
                                        filePath: track.filePath,
                                    },
                                });
                                totalTracksAdded++;
                            }
                        }
                    });

                    logger.debug(
                        `       ✓ Added ${tracks.length} track(s) to Discovery Weekly`
                    );
                } catch (error: any) {
                    logger.error(
                        `       ✗ Failed to create Discovery records: ${error.message}`
                    );
                }
            }
        }

        logger.debug(
            `   Reconciliation complete: ${totalTracksAdded} tracks added across ${batchesChecked} batches`
        );

        return {
            batchesChecked,
            tracksAdded: totalTracksAdded,
        };
    }

    /**
     * Cleanup orphaned Lidarr queue items that belong to this discovery batch
     * but are no longer needed (download completed but album not in final playlist)
     */
    private async cleanupOrphanedLidarrQueue(batchId: string): Promise<void> {
        logger.debug(`\n[CLEANUP] Checking for orphaned Lidarr queue items...`);

        try {
            const batch = await prisma.discoveryBatch.findUnique({
                where: { id: batchId },
                include: { jobs: true },
            });

            if (!batch) return;

            const settings = await getSystemSettings();
            if (
                !settings?.lidarrEnabled ||
                !settings?.lidarrUrl ||
                !settings?.lidarrApiKey
            ) {
                return;
            }

            // Get all download IDs from our batch jobs
            const ourDownloadIds = new Set<string>();
            for (const job of batch.jobs) {
                if (job.lidarrRef) {
                    ourDownloadIds.add(job.lidarrRef);
                }
            }

            if (ourDownloadIds.size === 0) {
                logger.debug(`   No download IDs to check`);
                return;
            }

            // Get Lidarr queue
            const queueResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/queue`,
                {
                    params: { pageSize: 500 },
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 30000,
                }
            );

            const queueItems = queueResponse.data?.records || [];
            let removed = 0;

            for (const item of queueItems) {
                const downloadId = item.downloadId;

                // Check if this is one of our downloads
                if (downloadId && ourDownloadIds.has(downloadId)) {
                    // Check if it's in a stuck state
                    const isStuck =
                        item.status === "warning" ||
                        item.status === "failed" ||
                        item.trackedDownloadState === "importFailed" ||
                        item.trackedDownloadState === "importBlocked";

                    if (isStuck) {
                        try {
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/queue/${item.id}`,
                                {
                                    params: {
                                        removeFromClient: true,
                                        blocklist: true,
                                    },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                }
                            );
                            logger.debug(
                                `   Removed orphaned queue item: ${item.title}`
                            );
                            removed++;
                        } catch (e) {
                            // Ignore removal errors
                        }
                    }
                }
            }

            if (removed > 0) {
                logger.debug(`   Cleaned up ${removed} orphaned queue item(s)`);
            } else {
                logger.debug(`   No orphaned queue items found`);
            }
        } catch (error: any) {
            logger.error(
                `[CLEANUP] Error cleaning orphaned queue:`,
                error.message
            );
        }
    }

    /**
     * Cleanup artists from Lidarr that failed during discovery
     * Only removes artists that:
     * - Had ALL their downloads fail in this batch
     * - Don't have any other music in the user's library
     *
     * NOTE: With tag-based tracking, we simply remove artists with the discovery tag
     * who don't have successful downloads. The tag is the source of truth.
     */
    private async cleanupFailedArtists(batchId: string): Promise<void> {
        logger.debug(
            `\n[CLEANUP] Tag-based cleanup for failed discovery artists...`
        );

        const batch = await prisma.discoveryBatch.findUnique({
            where: { id: batchId },
            include: { jobs: true },
        });

        if (!batch) return;

        // Build set of artists with successful downloads in this batch
        const successfulArtistMbids = new Set<string>();
        for (const job of batch.jobs) {
            if (job.status === "completed") {
                const metadata = job.metadata as any;
                if (metadata?.artistMbid) {
                    successfulArtistMbids.add(metadata.artistMbid);
                }
            }
        }

        logger.debug(
            `   ${successfulArtistMbids.size} artists had successful downloads`
        );

        // Get all artists with the discovery tag
        const discoveryArtists = await lidarrService.getDiscoveryArtists();
        logger.debug(
            `   ${discoveryArtists.length} artists in Lidarr have discovery tag`
        );

        let removed = 0;
        let kept = 0;

        for (const lidarrArtist of discoveryArtists) {
            const artistMbid = lidarrArtist.foreignArtistId;
            const artistName = lidarrArtist.artistName;

            if (!artistMbid) continue;

            // Keep if artist had successful downloads in this batch
            if (successfulArtistMbids.has(artistMbid)) {
                kept++;
                continue;
            }

            // Keep if artist has liked/moved discovery albums
            const hasKept = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid,
                    status: { in: ["LIKED", "MOVED"] },
                },
            });

            if (hasKept) {
                logger.debug(
                    `   Keeping ${artistName} - has liked albums (removing tag)`
                );
                await lidarrService.removeDiscoveryTagByMbid(artistMbid);
                kept++;
                continue;
            }

            // Keep if artist has ACTIVE discovery albums from other weeks
            const hasActiveOther = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid,
                    status: "ACTIVE",
                    weekStartDate: { not: batch.weekStart },
                },
            });

            if (hasActiveOther) {
                logger.debug(
                    `   Keeping ${artistName} - has active albums from other batches`
                );
                kept++;
                continue;
            }

            // Artist has discovery tag, no successful downloads, no liked albums = remove
            try {
                const result = await lidarrService.deleteArtistById(
                    lidarrArtist.id,
                    true
                );
                if (result.success) {
                    logger.debug(` Removed: ${artistName}`);
                    removed++;
                }
            } catch (error: any) {
                logger.error(
                    ` Failed to remove ${artistName}: ${error.message}`
                );
            }
        }

        logger.debug(`   Cleanup complete: ${removed} removed, ${kept} kept`);
        await discoveryBatchLogger.info(
            batchId,
            `Lidarr cleanup: ${removed} failed artists removed`
        );
    }

    /**
     * Check if an artist is already in the user's library
     * Discovery should find NEW artists, not more albums from artists they already own
     */
    private async isArtistInLibrary(
        artistName: string,
        artistMbid: string | undefined
    ): Promise<boolean> {
        const library = await openLibraryReader();
        // A placeholder MBID matches nothing and would only cost a query.
        const mbid =
            artistMbid && !artistMbid.startsWith("temp-") ? artistMbid : null;
        const owned = await library.isArtistOwned(artistName, mbid);

        if (owned) {
            logger.debug(`     [LIBRARY] ${artistName} IN LIBRARY`);
        }
        return owned;
    }

    /**
     * Check if an album is owned by artist name + album title
     * This catches cases where the MBID doesn't match but the album exists
     */
    private async isAlbumOwnedByName(
        artistName: string,
        albumTitle: string
    ): Promise<boolean> {
        // Normalize for comparison
        const normalizedArtist = artistName.toLowerCase().trim();
        const normalizedAlbum = albumTitle
            .toLowerCase()
            .replace(/\(.*?\)/g, "") // Remove parenthetical content
            .replace(/\[.*?\]/g, "") // Remove bracketed content
            .replace(
                /[-–—]\s*(deluxe|remaster|bonus|special|anniversary|expanded|limited|collector).*$/i,
                ""
            )
            .trim();

        const library = await openLibraryReader();
        const owned = await library.isAlbumOwned(
            normalizedArtist,
            normalizedAlbum
        );
        if (owned) {
            logger.debug(
                `     [OWNED-NAME] Found "${albumTitle}" by "${artistName}" in the library`
            );
            return true;
        }

        return false;
    }

    /**
     * Check if album was recommended recently (6 months)
     */
    private async isAlbumExcluded(
        albumMbid: string,
        userId: string
    ): Promise<boolean> {
        const exclusion = await prisma.discoverExclusion.findFirst({
            where: {
                userId,
                albumMbid,
                expiresAt: { gt: new Date() },
            },
        });
        return !!exclusion;
    }

    /**
     * Find a replacement album when download fails after all retries.
     * Uses multi-tier fallback prioritizing ARTIST DIVERSITY:
     * - Tier 2: Album from DIFFERENT similar artist (prioritize diversity!)
     * - Tier 3: Another album from SAME artist (last resort fallback)
     */
    async findReplacementAlbum(
        failedJob: any,
        batch: any
    ): Promise<{
        artistName: string;
        artistMbid: string;
        albumTitle: string;
        albumMbid: string;
        similarity: number;
    } | null> {
        const metadata = failedJob.metadata as any;
        const failedArtistMbid = metadata?.artistMbid;

        logger.debug(
            `[Discovery] Finding replacement for: ${metadata?.artistName} - ${metadata?.albumTitle}`
        );

        // Get all MBIDs and ARTIST MBIDs already attempted in this batch (for diversity tracking)
        const attemptedMbids = new Set<string>();
        const attemptedArtistMbids = new Set<string>();
        const batchJobs = await prisma.downloadJob.findMany({
            where: { discoveryBatchId: batch.id },
        });
        for (const job of batchJobs) {
            attemptedMbids.add(job.targetMbid);
            const jobMeta = job.metadata as any;
            if (jobMeta?.artistMbid) {
                attemptedArtistMbids.add(jobMeta.artistMbid);
            }
        }

        logger.debug(
            `[Discovery]   Already have ${attemptedArtistMbids.size} artists in batch, prioritizing new artists`
        );

        // Tier 2: Try album from DIFFERENT similar artist - search ALL seeds with more similar artists
        // IMPORTANT: Never pick same artist twice for diversity!
        logger.debug(
            `[Discovery]   Tier 2: Searching ALL seeds for albums from NEW artists (diversity enforced)`
        );
        const seeds = await discoverySeeding.getSeedArtists(batch.userId);

        // Search ALL seeds (not just 5) to maximize chances of finding new artists
        for (const seed of seeds) {
            if (!seed.mbid) continue;

            try {
                // Get MORE similar artists per seed (30 instead of 15)
                const similarArtists = await lastFmService.getSimilarArtists(
                    seed.mbid,
                    seed.name,
                    30
                );

                for (const similar of similarArtists) {
                    // Skip artists we already have in this batch (including the failed artist)
                    if (!similar.mbid) continue;
                    if (similar.mbid === failedArtistMbid) continue;
                    if (attemptedArtistMbids.has(similar.mbid)) {
                        continue; // Skip - we already have an album from this artist
                    }

                    // Get more albums to increase chances of finding available one
                    const albums = await lastFmService.getArtistTopAlbums(
                        similar.mbid,
                        similar.name,
                        5
                    );

                    for (const album of albums) {
                        // Get MBID from MusicBrainz
                        const mbAlbum = await musicBrainzService.searchAlbum(
                            album.name,
                            similar.name
                        );

                        if (mbAlbum && !attemptedMbids.has(mbAlbum.id)) {
                            // Check if artist is already in library (Discovery = NEW artists only!)
                            try {
                                const artistInLibrary =
                                    await this.isArtistInLibrary(
                                        similar.name,
                                        similar.mbid
                                    );
                                if (artistInLibrary) {
                                    logger.debug(
                                        `[Discovery]   Skipping ${similar.name} - already in library`
                                    );
                                    continue;
                                }
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isArtistInLibrary error for ${similar.name}: ${e.message}`
                                );
                                // Continue anyway - assume not in library if check fails
                            }

                            // Check if owned
                            try {
                                const owned = await discoverySeeding.isAlbumOwned(
                                    mbAlbum.id,
                                    batch.userId
                                );
                                if (owned) continue;
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isAlbumOwned error: ${e.message}`
                                );
                                continue; // Skip on error
                            }

                            // Check if excluded
                            try {
                                const excluded = await this.isAlbumExcluded(
                                    mbAlbum.id,
                                    batch.userId
                                );
                                if (excluded) continue;
                            } catch (e: any) {
                                logger.error(
                                    `[Discovery]   isAlbumExcluded error: ${e.message}`
                                );
                                continue; // Skip on error
                            }

                            logger.debug(
                                `[Discovery]   Tier 2 replacement found: ${album.name} by ${similar.name} (NEW artist!)`
                            );
                            return {
                                artistName: similar.name,
                                artistMbid: similar.mbid,
                                albumTitle: album.name,
                                albumMbid: mbAlbum.id,
                                similarity: similar.match || 0.5,
                            };
                        }
                    }
                }
            } catch (e) {
                continue;
            }
        }

        // NOTE: Same-artist fallback REMOVED - we enforce strict one-album-per-artist
        // If we can't find a new artist, go straight to library anchor
        logger.debug(
            `[Discovery]   No new artists found, using library anchor (diversity enforced)`
        );

        // Tier 3: Use track from user's library as anchor (related to discovery seeds)
        logger.debug(
            `[Discovery]   Tier 3: Selecting anchor track from user's library (seed artists)`
        );
        try {
            // Get a random album from seed artists that user already owns
            for (const seed of seeds.slice(0, 5)) {
                const ownedAlbum = await prisma.album.findFirst({
                    where: {
                        artist: {
                            OR: [
                                { mbid: seed.mbid || "___none___" },
                                {
                                    name: {
                                        equals: seed.name,
                                        mode: "insensitive",
                                    },
                                },
                            ],
                        },
                        tracks: { some: {} }, // Has tracks
                    },
                    include: { artist: true },
                });

                if (
                    ownedAlbum &&
                    ownedAlbum.rgMbid &&
                    !attemptedMbids.has(ownedAlbum.rgMbid)
                ) {
                    logger.debug(
                        `[Discovery]   Tier 3 anchor found: ${ownedAlbum.artist.name} - ${ownedAlbum.title} (from library)`
                    );
                    return {
                        artistName: ownedAlbum.artist.name,
                        artistMbid: ownedAlbum.artist.mbid,
                        albumTitle: ownedAlbum.title,
                        albumMbid: ownedAlbum.rgMbid,
                        similarity: 1.0, // Library = perfect match
                        isLibraryAnchor: true, // Flag so we know not to download
                    } as any;
                }
            }
        } catch (e) {
            logger.debug(
                `[Discovery]   Tier 3 search failed: ${(e as Error).message}`
            );
        }

        logger.debug(`[Discovery]   No replacement found`);
        return null;
    }

    /**
     * Find recommended albums using pre-cached similar artists
     * TWO-PASS APPROACH:
     * 1. First pass: Prioritize NEW artists (not in library)
     * 2. Second pass: Fall back to existing artists if needed
     */
    private async findRecommendedAlbums(
        seeds: SeedArtist[],
        similarCache: Map<string, any[]>,
        targetCount: number,
        userId: string
    ): Promise<RecommendedAlbum[]> {
        const recommendations: RecommendedAlbum[] = [];
        const seenArtists = new Set<string>();
        const seenAlbums = new Set<string>();
        const existingArtistsForFallback: any[] = []; // Artists in library saved for second pass

        logger.debug(`\n Finding ${targetCount} recommended albums...`);
        logger.debug(`   Seeds: ${seeds.map((s) => s.name).join(", ")}`);

        let totalSimilarArtists = 0;
        let totalAlbumsChecked = 0;
        let skippedNoMbid = 0;
        let skippedOwned = 0;
        let skippedExcluded = 0;
        let skippedDuplicate = 0;
        let skippedArtistInLibrary = 0;
        let addedFromExistingArtists = 0;

        // Collect all similar artists from all seeds
        const allSimilarArtists: any[] = [];
        for (const seed of seeds) {
            const similar = similarCache.get(seed.mbid || seed.name) || [];
            for (const sim of similar) {
                allSimilarArtists.push(sim);
            }
        }
        logger.debug(
            `   Total similar artists from all seeds: ${allSimilarArtists.length}`
        );

        logger.debug(`\n   === PASS 1: NEW Artists Only ===`);

        for (const sim of allSimilarArtists) {
            if (recommendations.length >= targetCount) break;

            const key = sim.name.toLowerCase();
            if (seenArtists.has(key)) continue;
            seenArtists.add(key);
            totalSimilarArtists++;

            // Check if artist is in library
            let artistInLibrary = false;
            try {
                artistInLibrary = await this.isArtistInLibrary(
                    sim.name,
                    sim.mbid
                );
            } catch (e: any) {
                logger.error(
                    `     isArtistInLibrary ERROR for ${sim.name}: ${e.message}`
                );
            }

            if (artistInLibrary) {
                skippedArtistInLibrary++;
                existingArtistsForFallback.push(sim); // Save for second pass
                continue;
            }

            // Process albums for this NEW artist
            const album = await this.findValidAlbumForArtist(
                sim,
                userId,
                seenAlbums
            );
            if (album) {
                totalAlbumsChecked += album.albumsChecked;
                skippedNoMbid += album.skippedNoMbid;
                skippedOwned += album.skippedOwned;
                skippedExcluded += album.skippedExcluded;
                skippedDuplicate += album.skippedDuplicate;

                if (album.recommendation) {
                    recommendations.push(album.recommendation);
                    logger.debug(
                        `    ✓ ADDED (NEW): ${sim.name} - ${album.recommendation.albumTitle}`
                    );
                }
            }
        }

        logger.debug(
            `   Pass 1 complete: ${recommendations.length}/${targetCount} from NEW artists`
        );

        if (
            recommendations.length < targetCount &&
            existingArtistsForFallback.length > 0
        ) {
            logger.debug(`\n   === PASS 2: Existing Artists (fallback) ===`);
            logger.debug(
                `   Need ${targetCount - recommendations.length} more, have ${
                    existingArtistsForFallback.length
                } existing artists to try`
            );

            for (const sim of existingArtistsForFallback) {
                if (recommendations.length >= targetCount) break;

                // Process albums for this EXISTING artist (find new albums they don't own)
                const album = await this.findValidAlbumForArtist(
                    sim,
                    userId,
                    seenAlbums
                );
                if (album) {
                    totalAlbumsChecked += album.albumsChecked;
                    skippedNoMbid += album.skippedNoMbid;
                    skippedOwned += album.skippedOwned;
                    skippedExcluded += album.skippedExcluded;
                    skippedDuplicate += album.skippedDuplicate;

                    if (album.recommendation) {
                        recommendations.push(album.recommendation);
                        addedFromExistingArtists++;
                        logger.debug(
                            `    ✓ ADDED (EXISTING): ${sim.name} - ${album.recommendation.albumTitle}`
                        );
                    }
                }
            }

            logger.debug(
                `   Pass 2 complete: Added ${addedFromExistingArtists} from existing artists`
            );
        }

        // Summary logging
        logger.debug(`\n   === Recommendation Summary ===`);
        logger.debug(`   Similar artists checked: ${totalSimilarArtists}`);
        logger.debug(
            `   Artists already in library (fallback pool): ${skippedArtistInLibrary}`
        );
        logger.debug(`   Albums checked: ${totalAlbumsChecked}`);
        logger.debug(`   Skipped (no MBID from MusicBrainz): ${skippedNoMbid}`);
        logger.debug(`   Skipped (album already owned): ${skippedOwned}`);
        logger.debug(
            `   Skipped (excluded - recently recommended): ${skippedExcluded}`
        );
        logger.debug(`   Skipped (duplicate): ${skippedDuplicate}`);
        logger.debug(` Found ${recommendations.length} albums total`);
        logger.debug(
            `     - ${
                recommendations.length - addedFromExistingArtists
            } from NEW artists`
        );
        logger.debug(
            `     - ${addedFromExistingArtists} from EXISTING artists (fallback)`
        );

        if (recommendations.length === 0 && totalSimilarArtists === 0) {
            logger.debug(
                `   [WARN] No similar artists found! Check Last.fm API configuration.`
            );
        } else if (recommendations.length === 0 && totalAlbumsChecked === 0) {
            logger.debug(
                `   [WARN] No albums returned from Last.fm! Check getArtistTopAlbums.`
            );
        } else if (
            recommendations.length === 0 &&
            skippedNoMbid === totalAlbumsChecked
        ) {
            logger.debug(
                `   [WARN] All albums failed MusicBrainz lookup! Check searchAlbum.`
            );
        } else if (
            recommendations.length === 0 &&
            skippedOwned >= totalAlbumsChecked
        ) {
            logger.debug(
                `   [WARN] All albums already owned! Need more variety in similar artists.`
            );
        }

        return recommendations;
    }

    /**
     * Helper: Find a valid album for a given artist
     * Returns the first album that passes all checks (owned, excluded, etc.)
     */
    private async findValidAlbumForArtist(
        artist: any,
        userId: string,
        seenAlbums: Set<string>
    ): Promise<{
        recommendation: RecommendedAlbum | null;
        albumsChecked: number;
        skippedNoMbid: number;
        skippedOwned: number;
        skippedExcluded: number;
        skippedDuplicate: number;
    }> {
        let albumsChecked = 0;
        let skippedNoMbid = 0;
        let skippedOwned = 0;
        let skippedExcluded = 0;
        let skippedDuplicate = 0;

        // Patterns to exclude non-studio releases
        const EXCLUDE_PATTERNS = [
            /\blive\b/i,
            /\bep\b$/i, // Only at end of title
            /\bacoustic\b/i,
            /\bsession[s]?\b/i,
            /\bcompilation\b/i,
            /\bgreatest\s*hits\b/i,
            /\bbest\s*of\b/i,
            /\bremix(es|ed)?\b/i,
            /\bunplugged\b/i,
            /\bcollection\b/i,
            /\banthology\b/i,
            /\bdemo[s]?\b/i,
        ];

        const isStudioAlbum = (title: string): boolean => {
            return !EXCLUDE_PATTERNS.some((pattern) => pattern.test(title));
        };

        try {
            // Get 10 albums per artist (was 5) to increase chances of finding available content
            const topAlbums = await lastFmService.getArtistTopAlbums(
                artist.mbid || "",
                artist.name,
                10
            );

            if (topAlbums.length === 0) {
                return {
                    recommendation: null,
                    albumsChecked: 0,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            }

            for (const album of topAlbums) {
                albumsChecked++;

                // Skip non-studio albums (live, compilations, EPs, etc.)
                if (!isStudioAlbum(album.name)) {
                    continue;
                }

                // Get MBID from MusicBrainz
                const mbAlbum = await musicBrainzService.searchAlbum(
                    album.name,
                    artist.name
                );

                if (!mbAlbum) {
                    skippedNoMbid++;
                    continue;
                }

                // Skip duplicates
                if (seenAlbums.has(mbAlbum.id)) {
                    skippedDuplicate++;
                    continue;
                }
                seenAlbums.add(mbAlbum.id);

                // Skip if owned by MBID
                try {
                    const owned = await discoverySeeding.isAlbumOwned(mbAlbum.id, userId);
                    if (owned) {
                        skippedOwned++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Skip if owned by name (catches MBID mismatches)
                try {
                    const ownedByName = await this.isAlbumOwnedByName(
                        artist.name,
                        album.name
                    );
                    if (ownedByName) {
                        skippedOwned++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Check if album was recently recommended (exclusion period)
                try {
                    const excluded = await this.isAlbumExcluded(
                        mbAlbum.id,
                        userId
                    );
                    if (excluded) {
                        skippedExcluded++;
                        continue;
                    }
                } catch (e: any) {
                    continue;
                }

                // Found a valid album!
                return {
                    recommendation: {
                        artistName: artist.name,
                        artistMbid: artist.mbid,
                        albumTitle: album.name,
                        albumMbid: mbAlbum.id,
                        similarity: artist.match || 0.5,
                    },
                    albumsChecked,
                    skippedNoMbid,
                    skippedOwned,
                    skippedExcluded,
                    skippedDuplicate,
                };
            }
        } catch (error: any) {
            logger.warn(
                `   Failed to get albums for ${artist.name}: ${error.message}`
            );
        }

        return {
            recommendation: null,
            albumsChecked,
            skippedNoMbid,
            skippedOwned,
            skippedExcluded,
            skippedDuplicate,
        };
    }

    /**
     * Get user's top genres from listening history
     */
    private async getUserTopGenres(userId: string): Promise<string[]> {
        try {
            const recentPlays = await prisma.play.findMany({
                where: {
                    userId,
                    playedAt: { gte: subWeeks(new Date(), 12) },
                },
                take: 500,
            });
            const nativeTrackIds: string[] = [];
            const jellyfinTrackIds: string[] = [];
            for (const play of recentPlays) {
                if (!play.trackId) continue;
                if (play.trackId.startsWith("jellyfin:")) {
                    jellyfinTrackIds.push(play.trackId);
                } else {
                    nativeTrackIds.push(play.trackId);
                }
            }
            const tracksWithArtist = await prisma.track.findMany({
                where: { id: { in: nativeTrackIds } },
                include: {
                    album: { include: { artist: true } },
                },
            });
            const artistByTrackId = new Map(
                tracksWithArtist.map((t) => [t.id, t.album?.artist])
            );

            const genreCounts = new Map<string, number>();
            const countGenre = (genre: string) => {
                const key = genre.trim().toLowerCase();
                if (key) genreCounts.set(key, (genreCounts.get(key) || 0) + 1);
            };

            // Jellyfin plays carry their genres on the synced track metadata;
            // there is no Artist row to read them from.
            if (jellyfinTrackIds.length > 0) {
                const jellyfinGenres =
                    await prisma.jellyfinTrackMetadata.findMany({
                        where: { jellyfinId: { in: jellyfinTrackIds } },
                        select: { jellyfinId: true, genres: true },
                    });
                const genresByTrackId = new Map(
                    jellyfinGenres.map((t) => [t.jellyfinId, t.genres])
                );
                for (const trackId of jellyfinTrackIds) {
                    for (const genre of genresByTrackId.get(trackId) ?? []) {
                        countGenre(genre);
                    }
                }
            }

            for (const play of recentPlays) {
                const artist = artistByTrackId.get(play.trackId);
                if (!artist) continue;

                // Collect canonical genres
                if (artist.genres) {
                    const genres = Array.isArray(artist.genres)
                        ? artist.genres
                        : ((artist.genres as string) || "")
                              .split(",")
                              .map((g: string) => g.trim());

                    for (const genre of genres) {
                        if (typeof genre === "string") countGenre(genre);
                    }
                }

                // Also collect user-added genres (metadata override system)
                if (artist.userGenres) {
                    const userGenres = Array.isArray(artist.userGenres)
                        ? artist.userGenres
                        : [];

                    for (const genre of userGenres) {
                        if (typeof genre === "string") countGenre(genre);
                    }
                }
            }

            // Sort by count and return top genres
            return Array.from(genreCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 10)
                .map(([genre]) => genre);
        } catch (error) {
            logger.error("Error getting user genres:", error);
            return [];
        }
    }

    /**
     * TAG EXPLORATION STRATEGY
     * Find albums by the user's top genre tags via Last.fm
     */
    private async tagExplorationStrategy(
        userId: string,
        targetCount: number,
        seenAlbums: Set<string>
    ): Promise<RecommendedAlbum[]> {
        logger.debug(
            `\n[STRATEGY] Tag Exploration - finding studio albums by genre`
        );

        const recommendations: RecommendedAlbum[] = [];
        const genres = await this.getUserTopGenres(userId);

        // Patterns to exclude non-studio releases
        const EXCLUDE_PATTERNS = [
            /\blive\b/i,
            /\bep\b$/i,
            /\bacoustic\b/i,
            /\bsession[s]?\b/i,
            /\bcompilation\b/i,
            /\bgreatest\s*hits\b/i,
            /\bbest\s*of\b/i,
            /\bremix(es|ed)?\b/i,
            /\bunplugged\b/i,
            /\bcollection\b/i,
            /\banthology\b/i,
            /\bdemo[s]?\b/i,
        ];

        const isStudioAlbum = (title: string): boolean => {
            return !EXCLUDE_PATTERNS.some((pattern) => pattern.test(title));
        };

        if (genres.length === 0) {
            logger.debug(`   No genres found for user, using fallback tags`);
            genres.push("rock", "indie", "alternative"); // Fallback
        }

        logger.debug(`   User's top genres: ${genres.slice(0, 5).join(", ")}`);

        for (const genre of genres.slice(0, 5)) {
            if (recommendations.length >= targetCount) break;

            try {
                // Use Last.fm's getTopAlbumsByTag
                const tagAlbums = await lastFmService.getTopAlbumsByTag(
                    genre,
                    30
                );

                for (const album of tagAlbums) {
                    if (recommendations.length >= targetCount) break;

                    const artistName = album.artist?.name || album.artist;
                    if (!artistName || !album.name) continue;

                    // Skip non-studio albums
                    if (!isStudioAlbum(album.name)) continue;

                    // Get MBID from MusicBrainz
                    const mbAlbum = await musicBrainzService.searchAlbum(
                        album.name,
                        artistName
                    );
                    if (!mbAlbum || seenAlbums.has(mbAlbum.id)) continue;

                    // Check if owned by MBID
                    const owned = await discoverySeeding.isAlbumOwned(mbAlbum.id, userId);
                    if (owned) continue;

                    // Check if owned by name (catches MBID mismatches)
                    const ownedByName = await this.isAlbumOwnedByName(
                        artistName,
                        album.name
                    );
                    if (ownedByName) continue;

                    // Check if album was recently recommended (exclusion period)
                    const excluded = await this.isAlbumExcluded(
                        mbAlbum.id,
                        userId
                    );
                    if (excluded) continue;

                    // Check if artist is in library (prefer new artists)
                    const inLibrary = await this.isArtistInLibrary(
                        artistName,
                        undefined
                    );
                    if (inLibrary) continue;

                    seenAlbums.add(mbAlbum.id);
                    recommendations.push({
                        artistName,
                        albumTitle: album.name,
                        albumMbid: mbAlbum.id,
                        similarity: 0.7, // Tag-based discovery
                        tier: "wildcard",
                    });
                    logger.debug(
                        `   ✓ TAG: ${artistName} - ${album.name} (${genre})`
                    );
                }
            } catch (error: any) {
                logger.warn(
                    `   Tag search failed for ${genre}: ${error.message}`
                );
            }
        }

        logger.debug(
            `   Tag exploration found ${recommendations.length} albums`
        );
        return recommendations;
    }

    /**
     * Main recommendation engine with tier-based selection
     * Combines similar artists (by tier) + genre wildcards for variety
     *
     * Distribution:
     * - 30% HIGH tier (>70% similar)
     * - 40% MEDIUM tier (50-70% similar)
     * - 20% EXPLORE tier (30-50% similar)
     * - 10% WILDCARD (genre tags)
     */
    async findRecommendedAlbumsMultiStrategy(
        seeds: SeedArtist[],
        similarCache: Map<string, any[]>,
        targetCount: number,
        userId: string
    ): Promise<RecommendedAlbum[]> {
        const seenAlbums = new Set<string>();
        const seenArtists = new Set<string>();
        const recommendations: RecommendedAlbum[] = [];

        logger.debug(`\n[DISCOVERY] Tier-Based Selection`);
        logger.debug(`   Target: ${targetCount} albums`);
        logger.debug(
            `   Distribution: 30% high, 40% medium, 20% explore, 10% wildcard`
        );

        // Calculate counts for each tier
        const wildcardCount = Math.max(
            1,
            Math.ceil(targetCount * TIER_DISTRIBUTION.wildcard)
        );
        const similarArtistTarget = targetCount - wildcardCount;

        const highCount = Math.ceil(
            similarArtistTarget * (TIER_DISTRIBUTION.high / 0.9)
        );
        const mediumCount = Math.ceil(
            similarArtistTarget * (TIER_DISTRIBUTION.medium / 0.9)
        );
        const exploreCount = similarArtistTarget - highCount - mediumCount;

        logger.debug(
            `   Targets: ${highCount} high, ${mediumCount} medium, ${exploreCount} explore, ${wildcardCount} wildcard`
        );

        // Collect all similar artists from all seeds
        const allSimilarArtists: any[] = [];
        for (const seed of seeds) {
            const similar = similarCache.get(seed.mbid || seed.name) || [];
            for (const sim of similar) {
                allSimilarArtists.push(sim);
            }
        }

        // Group similar artists by tier (based on Last.fm match score)
        // Thresholds adjusted for better distribution (Last.fm returns 0.5-0.9 range typically)
        const byTier = {
            high: allSimilarArtists.filter((a) => (a.match || 0) >= 0.7),
            medium: allSimilarArtists.filter(
                (a) => (a.match || 0) >= 0.5 && (a.match || 0) < 0.7
            ),
            explore: allSimilarArtists.filter(
                (a) => (a.match || 0) >= 0.3 && (a.match || 0) < 0.5
            ),
        };

        logger.debug(
            `   Available: ${byTier.high.length} high, ${byTier.medium.length} medium, ${byTier.explore.length} explore`
        );

        // Debug: Show top artists from each tier with their match scores
        if (byTier.high.length > 0) {
            logger.debug(
                `   HIGH tier sample: ${byTier.high
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.match * 100).toFixed(0)}%)`)
                    .join(", ")}`
            );
        }
        if (byTier.medium.length > 0) {
            logger.debug(
                `   MEDIUM tier sample: ${byTier.medium
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.match * 100).toFixed(0)}%)`)
                    .join(", ")}`
            );
        }
        if (byTier.explore.length > 0) {
            logger.debug(
                `   EXPLORE tier sample: ${byTier.explore
                    .slice(0, 3)
                    .map((a) => `${a.name}(${(a.match * 100).toFixed(0)}%)`)
                    .join(", ")}`
            );
        }

        // Shuffle each tier for variety week-to-week
        byTier.high = shuffleArray(byTier.high);
        byTier.medium = shuffleArray(byTier.medium);
        byTier.explore = shuffleArray(byTier.explore);

        // Helper to select from a tier
        const selectFromTier = async (
            tier: any[],
            count: number,
            tierName: "high" | "medium" | "explore"
        ): Promise<RecommendedAlbum[]> => {
            const selected: RecommendedAlbum[] = [];

            for (const artist of tier) {
                if (selected.length >= count) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                // Check if artist is in library (prefer NEW artists)
                let artistInLibrary = false;
                try {
                    artistInLibrary = await this.isArtistInLibrary(
                        artist.name,
                        artist.mbid
                    );
                } catch (e) {
                    // Continue on error
                }

                if (artistInLibrary) {
                    logger.debug(`      [SKIP] ${artist.name} - in library`);
                    continue;
                }

                // Find a valid album for this artist
                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums
                );

                if (result.recommendation) {
                    seenArtists.add(key);
                    result.recommendation.tier = tierName;
                    // Use the artist's actual match score for similarity
                    result.recommendation.similarity =
                        artist.match || result.recommendation.similarity;
                    selected.push(result.recommendation);
                    logger.debug(
                        `    ✓ [${tierName.toUpperCase()}] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${((artist.match || 0) * 100).toFixed(0)}%)`
                    );
                }
            }

            return selected;
        };

        // Select from each tier
        logger.debug(`\n   === Selecting from HIGH tier ===`);
        const highPicks = await selectFromTier(byTier.high, highCount, "high");
        recommendations.push(...highPicks);

        logger.debug(`\n   === Selecting from MEDIUM tier ===`);
        const mediumPicks = await selectFromTier(
            byTier.medium,
            mediumCount,
            "medium"
        );
        recommendations.push(...mediumPicks);

        logger.debug(`\n   === Selecting from EXPLORE tier ===`);
        const explorePicks = await selectFromTier(
            byTier.explore,
            exploreCount,
            "explore"
        );
        recommendations.push(...explorePicks);

        // If we didn't get enough from tiered selection, fill with any available NEW artists
        if (recommendations.length < similarArtistTarget) {
            logger.debug(
                `\n   === Filling remaining slots (NEW artists only) ===`
            );
            const remaining = similarArtistTarget - recommendations.length;
            const allRemaining = [
                ...byTier.high,
                ...byTier.medium,
                ...byTier.explore,
            ].filter((a) => !seenArtists.has(a.name.toLowerCase()));

            for (const artist of shuffleArray(allRemaining)) {
                if (recommendations.length >= similarArtistTarget) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                // Check if artist is in library (same as tier selection)
                let artistInLibrary = false;
                try {
                    artistInLibrary = await this.isArtistInLibrary(
                        artist.name,
                        artist.mbid
                    );
                } catch (e) {
                    // Continue on error
                }

                if (artistInLibrary) {
                    logger.debug(`      [SKIP] ${artist.name} - in library`);
                    continue;
                }

                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums
                );
                if (result.recommendation) {
                    seenArtists.add(key);
                    // Use the artist's actual match score for tier assignment
                    result.recommendation.tier = getTierFromSimilarity(
                        artist.match || result.recommendation.similarity
                    );
                    // Also update similarity to use actual match score
                    result.recommendation.similarity =
                        artist.match || result.recommendation.similarity;
                    recommendations.push(result.recommendation);
                    logger.debug(
                        `    ✓ [FILL] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${(artist.match * 100).toFixed(0)}%)`
                    );
                }
            }
        }

        // FALLBACK: If still not enough, allow existing artists with NEW albums
        if (recommendations.length < similarArtistTarget) {
            logger.debug(
                `\n   === FALLBACK: Existing artists with NEW albums ===`
            );
            logger.debug(
                `   Need ${
                    similarArtistTarget - recommendations.length
                } more recommendations`
            );

            const allRemaining = [
                ...byTier.high,
                ...byTier.medium,
                ...byTier.explore,
            ].filter((a) => !seenArtists.has(a.name.toLowerCase()));

            for (const artist of shuffleArray(allRemaining)) {
                if (recommendations.length >= similarArtistTarget) break;

                const key = artist.name.toLowerCase();
                if (seenArtists.has(key)) continue;

                // This time we ALLOW artists in library - we just want NEW albums from them
                const result = await this.findValidAlbumForArtist(
                    artist,
                    userId,
                    seenAlbums
                );
                if (result.recommendation) {
                    seenArtists.add(key);
                    result.recommendation.tier = getTierFromSimilarity(
                        artist.match || result.recommendation.similarity
                    );
                    result.recommendation.similarity =
                        artist.match || result.recommendation.similarity;
                    recommendations.push(result.recommendation);
                    logger.debug(
                        `    ✓ [EXISTING] ${artist.name} - ${
                            result.recommendation.albumTitle
                        } (${((artist.match || 0) * 100).toFixed(0)}%)`
                    );
                }
            }
        }

        // Add genre wildcards for variety
        logger.debug(
            `\n   === Adding ${wildcardCount} WILDCARD picks from genre tags ===`
        );
        const wildcards = await this.tagExplorationStrategy(
            userId,
            wildcardCount,
            seenAlbums
        );
        for (const wc of wildcards) {
            wc.tier = "wildcard";
            recommendations.push(wc);
        }

        // Summary
        const tierCounts = {
            high: recommendations.filter((r) => r.tier === "high").length,
            medium: recommendations.filter((r) => r.tier === "medium").length,
            explore: recommendations.filter((r) => r.tier === "explore").length,
            wildcard: recommendations.filter((r) => r.tier === "wildcard")
                .length,
        };

        logger.debug(`\n[DISCOVERY] Final: ${recommendations.length} albums`);
        logger.debug(
            `   High: ${tierCounts.high}, Medium: ${tierCounts.medium}, Explore: ${tierCounts.explore}, Wildcard: ${tierCounts.wildcard}`
        );

        return recommendations.slice(0, targetCount);
    }

    /**
     * Track-first recommendation engine (ADR 0007).
     *
     * Mirrors {@link findRecommendedAlbumsMultiStrategy} but yields individual
     * songs instead of albums. Used when
     * `UserDiscoverConfig.acquisitionMode === "track"`.
     *
     * Strategy:
     *  - Tier similar artists by Last.fm match (high/medium/explore), prefer
     *    NEW artists, and take a couple of their top tracks each
     *    (`artist.getTopTracks`).
     *  - Wildcard slots seed `track.getSimilar` off the user's seed artists'
     *    top tracks to surface cross-artist "song radio" picks.
     *
     * Reuses the same `similarCache` and tier thresholds as album mode so the
     * two modes stay tonally consistent.
     */
    async findRecommendedTracksMultiStrategy(
        seeds: SeedArtist[],
        similarCache: Map<string, any[]>,
        targetCount: number,
        userId: string
    ): Promise<RecommendedTrack[]> {
        const seenTracks = new Set<string>(); // `${artist}|${title}`
        const perArtistCount = new Map<string, number>();
        const recommendations: RecommendedTrack[] = [];

        // Spread picks across artists rather than dumping one artist's discography
        const MAX_PER_ARTIST = 2;

        const trackKey = (artist: string, title: string) =>
            `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}`;

        // Last.fm returns artist as a string, { name }, or { '#text' } depending on method
        const extractArtistName = (t: any): string => {
            if (!t) return "";
            if (typeof t.artist === "string") return t.artist;
            return t.artist?.name || t.artist?.["#text"] || "";
        };

        const addTrack = (
            artistName: string,
            trackTitle: string,
            opts: {
                artistMbid?: string;
                trackMbid?: string;
                similarity: number;
                tier: RecommendedTrack["tier"];
            }
        ): boolean => {
            if (!artistName || !trackTitle) return false;
            const key = trackKey(artistName, trackTitle);
            if (seenTracks.has(key)) return false;
            const aKey = artistName.toLowerCase().trim();
            if ((perArtistCount.get(aKey) || 0) >= MAX_PER_ARTIST) return false;
            seenTracks.add(key);
            perArtistCount.set(aKey, (perArtistCount.get(aKey) || 0) + 1);
            recommendations.push({
                artistName,
                artistMbid: opts.artistMbid,
                trackTitle,
                trackMbid: opts.trackMbid,
                similarity: opts.similarity,
                tier: opts.tier,
            });
            return true;
        };

        // Tier sizing — identical split to album mode
        const wildcardCount = Math.max(
            1,
            Math.ceil(targetCount * TIER_DISTRIBUTION.wildcard)
        );
        const similarTarget = targetCount - wildcardCount;
        const highCount = Math.ceil(
            similarTarget * (TIER_DISTRIBUTION.high / 0.9)
        );
        const mediumCount = Math.ceil(
            similarTarget * (TIER_DISTRIBUTION.medium / 0.9)
        );
        const exploreCount = similarTarget - highCount - mediumCount;

        // Collect + tier similar artists (same thresholds as album mode)
        const allSimilarArtists: any[] = [];
        for (const seed of seeds) {
            const similar = similarCache.get(seed.mbid || seed.name) || [];
            allSimilarArtists.push(...similar);
        }
        const byTier = {
            high: shuffleArray(
                allSimilarArtists.filter((a) => (a.match || 0) >= 0.7)
            ),
            medium: shuffleArray(
                allSimilarArtists.filter(
                    (a) => (a.match || 0) >= 0.5 && (a.match || 0) < 0.7
                )
            ),
            explore: shuffleArray(
                allSimilarArtists.filter(
                    (a) => (a.match || 0) >= 0.3 && (a.match || 0) < 0.5
                )
            ),
        };

        // Pull top tracks from NEW artists within a tier
        const selectFromTier = async (
            tier: any[],
            count: number,
            tierName: "high" | "medium" | "explore"
        ): Promise<void> => {
            const startLen = recommendations.length;
            for (const artist of tier) {
                if (recommendations.length - startLen >= count) break;
                try {
                    if (await this.isArtistInLibrary(artist.name, artist.mbid)) {
                        continue;
                    }
                } catch {
                    // ignore lookup errors, treat as not-in-library
                }
                let topTracks: any[] = [];
                try {
                    topTracks = await lastFmService.getArtistTopTracks(
                        artist.mbid || "",
                        artist.name,
                        5
                    );
                } catch {
                    continue;
                }
                let addedForArtist = 0;
                for (const t of topTracks) {
                    if (recommendations.length - startLen >= count) break;
                    if (addedForArtist >= MAX_PER_ARTIST) break;
                    const title = t?.name;
                    if (!title) continue;
                    if (
                        addTrack(artist.name, title, {
                            artistMbid: artist.mbid,
                            trackMbid: t?.mbid || undefined,
                            similarity: artist.match || 0,
                            tier: tierName,
                        })
                    ) {
                        addedForArtist++;
                    }
                }
            }
        };

        await selectFromTier(byTier.high, highCount, "high");
        await selectFromTier(byTier.medium, mediumCount, "medium");
        await selectFromTier(byTier.explore, exploreCount, "explore");

        // Wildcards: track.getSimilar seeded off the user's seed artists' top tracks
        if (recommendations.length < targetCount) {
            for (const seed of shuffleArray([...seeds])) {
                if (recommendations.length >= targetCount) break;
                let seedTop: any[] = [];
                try {
                    seedTop = await lastFmService.getArtistTopTracks(
                        seed.mbid || "",
                        seed.name,
                        1
                    );
                } catch {
                    continue;
                }
                const seedTrack = seedTop[0]?.name;
                if (!seedTrack) continue;
                let similar: any[] = [];
                try {
                    similar = await lastFmService.getSimilarTracks(
                        seed.name,
                        seedTrack,
                        20
                    );
                } catch {
                    continue;
                }
                for (const t of shuffleArray(similar)) {
                    if (recommendations.length >= targetCount) break;
                    const title = t?.name;
                    const artistName = extractArtistName(t);
                    if (!title || !artistName) continue;
                    try {
                        if (
                            await this.isArtistInLibrary(
                                artistName,
                                t?.artist?.mbid
                            )
                        ) {
                            continue;
                        }
                    } catch {
                        // ignore lookup errors
                    }
                    addTrack(artistName, title, {
                        artistMbid: t?.artist?.mbid || undefined,
                        trackMbid: t?.mbid || undefined,
                        similarity: parseFloat(t?.match) || 0,
                        tier: "wildcard",
                    });
                }
            }
        }

        logger.debug(
            `[DISCOVERY] Track-first: ${recommendations.length} tracks (target ${targetCount})`
        );

        return recommendations.slice(0, targetCount);
    }
}

export const discoverWeeklyService = new DiscoverWeeklyService();
