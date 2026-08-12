/**
 * Unified Enrichment Worker
 *
 * Handles ALL enrichment in one place:
 * - Artist metadata (Last.fm, MusicBrainz)
 * - Track mood tags (Last.fm)
 * - Audio analysis (triggers Essentia via Redis queue)
 *
 * Two modes:
 * 1. FULL: Re-enriches everything regardless of status (Settings > Enrich)
 * 2. INCREMENTAL: Only new material and incomplete items (Sync)
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { enrichSimilarArtist } from "./artistEnrichment";
import { lastFmService } from "../services/lastfm";
import type { RedisClientType } from "redis";
import { redisClient, createDedicatedRedis } from "../utils/redis";
import { config } from "../config";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { audioAnalysisCleanupService } from "../services/audioAnalysisCleanup";
import { rateLimiter } from "../services/rateLimiter";
import { vibeAnalysisCleanupService } from "../services/vibeAnalysisCleanup";
import { getSystemSettings } from "../utils/systemSettings";
import { featureDetection } from "../services/featureDetection";
import pLimit from "p-limit";

// Configuration
const ARTIST_BATCH_SIZE = 10;
const TRACK_BATCH_SIZE = 20;
const ENRICHMENT_INTERVAL_MS = 5 * 1000; // 5 seconds - rate limiter handles API limits
const MAX_CONSECUTIVE_SYSTEM_FAILURES = 5; // Circuit breaker threshold

let isRunning = false;
let enrichmentTimeoutId: NodeJS.Timeout | null = null;
let controlSubscriber: RedisClientType | null = null;
let isPaused = false;
let isStopping = false;
let immediateEnrichmentRequested = false;
let consecutiveSystemFailures = 0; // Track consecutive system-level failures
let lastRunTime = 0;
const MIN_INTERVAL_MS = 10000; // Minimum 10s between cycles

// Batch failure tracking
interface BatchFailures {
    artists: { name: string; error: string }[];
    tracks: { name: string; error: string }[];
    audio: { name: string; error: string }[];
}
let currentBatchFailures: BatchFailures = {
    artists: [],
    tracks: [],
    audio: [],
};

// Session-level failure counter (accumulates across cycles, reset on enrichment start)
let sessionFailureCount = { artists: 0, tracks: 0, audio: 0 };

// Mood tags to extract from Last.fm
const MOOD_TAGS = new Set([
    // Energy/Activity
    "chill",
    "relax",
    "relaxing",
    "calm",
    "peaceful",
    "ambient",
    "energetic",
    "upbeat",
    "hype",
    "party",
    "dance",
    "workout",
    "gym",
    "running",
    "exercise",
    "motivation",
    // Emotions
    "sad",
    "melancholy",
    "melancholic",
    "depressing",
    "heartbreak",
    "happy",
    "feel good",
    "feel-good",
    "joyful",
    "uplifting",
    "angry",
    "aggressive",
    "intense",
    "romantic",
    "love",
    "sensual",
    // Time/Setting
    "night",
    "late night",
    "evening",
    "morning",
    "summer",
    "winter",
    "rainy",
    "sunny",
    "driving",
    "road trip",
    "travel",
    // Activity
    "study",
    "focus",
    "concentration",
    "work",
    "sleep",
    "sleeping",
    "bedtime",
    // Vibe
    "dreamy",
    "atmospheric",
    "ethereal",
    "spacey",
    "groovy",
    "funky",
    "smooth",
    "dark",
    "moody",
    "brooding",
    "epic",
    "cinematic",
    "dramatic",
    "nostalgic",
    "throwback",
]);

/**
 * Timeout wrapper to prevent operations from hanging indefinitely
 * If an operation takes longer than the timeout, it will fail and move to the next item
 */
async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Filter tags to only include mood-relevant ones
 */
function filterMoodTags(tags: string[]): string[] {
    return tags
        .map((t) => t.toLowerCase().trim())
        .filter((t) => {
            if (MOOD_TAGS.has(t)) return true;
            for (const mood of MOOD_TAGS) {
                if (t.includes(mood)) return true;
            }
            return false;
        })
        .slice(0, 10);
}

/** Shared Redis client accessor for queue operations */
function getRedis() {
    return redisClient;
}

/**
 * Setup subscription to enrichment control channel
 */
async function setupControlChannel() {
    if (!controlSubscriber) {
        controlSubscriber = await createDedicatedRedis();
        await controlSubscriber.subscribe("enrichment:control", (message) => {
            logger.debug(
                `[Enrichment] Received control message: ${message}`,
            );

            if (message === "pause") {
                isPaused = true;
                logger.debug("[Enrichment] Paused");
            } else if (message === "resume") {
                isPaused = false;
                logger.debug("[Enrichment] Resumed");
            } else if (message === "stop") {
                isStopping = true;
                isPaused = true;
                logger.debug(
                    "[Enrichment] Stopping gracefully - completing current item...",
                );
            }
        });

        logger.debug("[Enrichment] Subscribed to control channel");
    }
}

/**
 * Start the unified enrichment worker (incremental mode)
 */
export async function startUnifiedEnrichmentWorker() {
    isStopping = false;
    logger.debug("\n=== Starting Unified Enrichment Worker ===");
    logger.debug(`   Artist batch: ${ARTIST_BATCH_SIZE}`);
    logger.debug(`   Track batch: ${TRACK_BATCH_SIZE}`);
    logger.debug(`   Interval: ${ENRICHMENT_INTERVAL_MS / 1000}s`);
    logger.debug("");

     // Check if there's existing state that might be problematic
     const existingState = await enrichmentStateService.getState();
     
     // Only clear state if it exists and is in a non-idle state
     // This prevents clearing fresh state from a previous worker instance
     if (existingState && existingState.status !== "idle") {
         await enrichmentStateService.clear();
     }
     
     // Initialize state
     await enrichmentStateService.initializeState();

    // Setup control channel subscription
    await setupControlChannel();

    // Run immediately
    await runEnrichmentCycle(false);

    // Self-rescheduling timeout (like reconciliation cycle) - prevents pile-up if a cycle
    // runs long. setInterval would fire unconditionally and create zombie operations.
    function scheduleNextCycle() {
        if (isStopping) return;
        enrichmentTimeoutId = setTimeout(async () => {
            enrichmentTimeoutId = null;
            await runEnrichmentCycle(false);
            scheduleNextCycle();
        }, ENRICHMENT_INTERVAL_MS);
    }
    scheduleNextCycle();
}

/**
 * Stop the enrichment worker
 */
export async function stopUnifiedEnrichmentWorker() {
    isStopping = true;
    if (enrichmentTimeoutId) {
        clearTimeout(enrichmentTimeoutId);
        enrichmentTimeoutId = null;
        logger.debug("[Enrichment] Worker stopped");
    }
    if (controlSubscriber) {
        await controlSubscriber.unsubscribe("enrichment:control").catch(() => {});
        await controlSubscriber.disconnect().catch(() => {});
        controlSubscriber = null;
    }

    // Mark as stopped in state
    enrichmentStateService
        .updateState({
            status: "idle",
            currentPhase: null,
        })
        .catch((err) =>
            logger.error("[Enrichment] Failed to update state:", err),
        );
}

/**
 * Run a full enrichment (re-enrich everything regardless of status)
 * Called from Settings > Enrich All
 */
export async function runFullEnrichment(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("\n=== FULL ENRICHMENT: Re-enriching everything ===\n");

    // Reset pause state when starting full enrichment
    isPaused = false;

    // Initialize state for new enrichment
    await enrichmentStateService.initializeState();

    // Reset all statuses to pending
    await prisma.artist.updateMany({
        data: { enrichmentStatus: "pending" },
    });

    await prisma.track.updateMany({
        data: {
            lastfmTags: [],
            analysisStatus: "pending",
        },
    });

    // Now run the enrichment cycle
    const result = await runEnrichmentCycle(true);

    return result;
}

/**
 * Reset only artist enrichment (keeps mood tags and audio analysis intact)
 * Used when user wants to re-fetch artist metadata without touching track data
 */
export async function resetArtistsOnly(): Promise<{ count: number }> {
    logger.debug("[Enrichment] Resetting ONLY artist enrichment status...");

    const result = await prisma.artist.updateMany({
        where: { enrichmentStatus: "completed" },
        data: {
            enrichmentStatus: "pending",
            lastEnriched: null,
        },
    });

    logger.debug(`[Enrichment] Reset ${result.count} artists to pending`);
    return { count: result.count };
}

/**
 * Reset only mood tags (keeps artist metadata and audio analysis intact)
 * Used when user wants to re-fetch Last.fm mood tags without touching other enrichment
 */
export async function resetMoodTagsOnly(): Promise<{ count: number }> {
    logger.debug("[Enrichment] Resetting ONLY mood tags...");

    const result = await prisma.track.updateMany({
        data: { lastfmTags: [] },
    });

    logger.debug(`[Enrichment] Reset mood tags for ${result.count} tracks`);
    return { count: result.count };
}

/**
 * Main enrichment cycle
 *
 * Flow:
 * 1. Artist metadata (Last.fm/MusicBrainz) - blocking, required for track enrichment
 * 2. Track tags (Last.fm mood tags) - blocking, quick API calls
 * 3. Audio analysis (Essentia) - NON-BLOCKING, queued to Redis for background processing
 *
 * Steps 1 & 2 must complete before enrichment is "done".
 * Step 3 runs entirely in background via the audio-analyzer Docker container.
 *
 * @param fullMode - If true, processes everything. If false, only pending items.
 */
async function runEnrichmentCycle(fullMode: boolean): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    const emptyResult = { artists: 0, tracks: 0, audioQueued: 0 };

    // Sync local pause flag with state service
    if (!isPaused) {
        const state = await enrichmentStateService.getState();
        if (state?.status === "paused" || state?.status === "stopping") {
            isPaused = true;
        }
    }

    if (isPaused) {
        return emptyResult;
    }

    // Skip if already running (unless full mode or immediate request)
    const bypassRunningCheck = fullMode || immediateEnrichmentRequested;
    if (isRunning && !bypassRunningCheck) {
        return emptyResult;
    }

    // Enforce minimum interval (unless full mode or immediate request)
    const now = Date.now();
    if (!bypassRunningCheck && now - lastRunTime < MIN_INTERVAL_MS) {
        return emptyResult;
    }

    immediateEnrichmentRequested = false;
    lastRunTime = now;
    isRunning = true;

    let artistsProcessed = 0;
    let tracksProcessed = 0;
    let audioQueued = 0;

    try {
        consecutiveSystemFailures = 0;

        // Run phases sequentially, halting if stopped/paused
        const artistResult = await runPhase("artists", executeArtistsPhase);
        if (artistResult === null) {
            return { artists: 0, tracks: 0, audioQueued: 0 };
        }
        artistsProcessed = artistResult;

        const trackResult = await runPhase("tracks", executeMoodTagsPhase);
        if (trackResult === null) {
            return { artists: artistsProcessed, tracks: 0, audioQueued: 0 };
        }
        tracksProcessed = trackResult;

        const audioResult = await runPhase("audio", executeAudioPhase);
        if (audioResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        audioQueued = audioResult;

        const vibeResult = await runPhase("vibe", executeVibePhase);
        if (vibeResult === null) {
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued };
        }
        const vibeQueued = vibeResult;

        // Podcast refresh phase -- only runs if subscriptions exist
        await runPhase("podcasts", executePodcastRefreshPhase);

        const features = await featureDetection.getFeatures();

         // Log progress (only if work was done)
         if (artistsProcessed > 0 || tracksProcessed > 0 || audioQueued > 0 || vibeQueued > 0) {
            const progress = await getEnrichmentProgress();
            logger.debug(`\n[Enrichment Progress]`);
            logger.debug(
                `   Artists: ${progress.artists.completed}/${progress.artists.total} (${progress.artists.progress}%)`,
            );
            logger.debug(
                `   Track Tags: ${progress.trackTags.enriched}/${progress.trackTags.total} (${progress.trackTags.progress}%)`,
            );
            logger.debug(
                `   Audio Analysis: ${progress.audioAnalysis.completed}/${progress.audioAnalysis.total} (${progress.audioAnalysis.progress}%) [background]`,
            );
            if (features.vibeEmbeddings) {
                logger.debug(
                    `   Vibe Embeddings: ${progress.clapEmbeddings.completed}/${progress.clapEmbeddings.total} (${progress.clapEmbeddings.progress}%) [background]`,
                );
            }
            logger.debug("");

            // Update state with progress
            await enrichmentStateService.updateState({
                artists: {
                    total: progress.artists.total,
                    completed: progress.artists.completed,
                    failed: progress.artists.failed,
                },
                tracks: {
                    total: progress.trackTags.total,
                    completed: progress.trackTags.enriched,
                    failed: 0,
                },
                audio: {
                    total: progress.audioAnalysis.total,
                    completed: progress.audioAnalysis.completed,
                    failed: progress.audioAnalysis.failed,
                    processing: progress.audioAnalysis.processing,
                },
                completionNotificationSent: false, // Reset flag when new work is processed
            });

            // Reset session failure counter when new work begins
            sessionFailureCount = { artists: 0, tracks: 0, audio: 0 };
        }

        // Accumulate cycle failures into session counter before resetting
        sessionFailureCount.artists += currentBatchFailures.artists.length;
        sessionFailureCount.tracks += currentBatchFailures.tracks.length;
        sessionFailureCount.audio += currentBatchFailures.audio.length;

        // Reset batch failures (failures are viewable in Settings > Enrichment)
        currentBatchFailures = { artists: [], tracks: [], audio: [] };

        // If everything is complete, mark as idle and send notification (only once)
        const progress = await getEnrichmentProgress();

        // Clear mixes cache when core enrichment completes (artist images now available)
        if (progress.coreComplete) {
            const state = await enrichmentStateService.getState();
            if (!state?.coreCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys = await redisInstance.keys("mixes:*");
                    if (mixKeys.length > 0) {
                        await redisInstance.del(mixKeys);
                        logger.info(
                            `[Enrichment] Cleared ${mixKeys.length} mix cache entries after core enrichment complete`,
                        );
                    }
                    await enrichmentStateService.updateState({
                        coreCacheCleared: true,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to clear mix cache on core complete:",
                        error,
                    );
                }
            }
        }

        if (progress.isFullyComplete) {
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
            });

            // Clear mixes cache again when fully complete (audio analysis done)
            const stateBeforeNotify = await enrichmentStateService.getState();
            if (!stateBeforeNotify?.fullCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys = await redisInstance.keys("mixes:*");
                    if (mixKeys.length > 0) {
                        await redisInstance.del(mixKeys);
                        logger.info(
                            `[Enrichment] Cleared ${mixKeys.length} mix cache entries after full enrichment complete`,
                        );
                    }
                    await enrichmentStateService.updateState({
                        fullCacheCleared: true,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to clear mix cache on full complete:",
                        error,
                    );
                }
            }

            // Send completion notification only if not already sent
            const state = await enrichmentStateService.getState();
            if (!state?.completionNotificationSent) {
                try {
                    const { notificationService } =
                        await import("../services/notificationService");
                    // Get all users to notify (in a multi-user system, notify everyone)
                    const users = await prisma.user.findMany({
                        select: { id: true },
                    });
                    const totalSessionFailures =
                        sessionFailureCount.artists +
                        sessionFailureCount.tracks +
                        sessionFailureCount.audio;

                    for (const user of users) {
                        if (totalSessionFailures > 0) {
                            const parts: string[] = [];
                            if (sessionFailureCount.artists > 0) parts.push(`${sessionFailureCount.artists} artist(s)`);
                            if (sessionFailureCount.tracks > 0) parts.push(`${sessionFailureCount.tracks} track(s)`);
                            if (sessionFailureCount.audio > 0) parts.push(`${sessionFailureCount.audio} audio analysis`);

                            await notificationService.create({
                                userId: user.id,
                                type: "error",
                                title: "Enrichment Completed with Errors",
                                message: `${totalSessionFailures} failures: ${parts.join(", ")}. Check Settings > Enrichment for details.`,
                            });
                        }

                        await notificationService.notifySystem(
                            user.id,
                            "Enrichment Complete",
                            `Enriched ${progress.artists.completed} artists, ${progress.trackTags.enriched} tracks, ${progress.audioAnalysis.completed} audio analyses`,
                        );
                    }

                    // Mark notification as sent
                    await enrichmentStateService.updateState({
                        completionNotificationSent: true,
                    });
                    logger.debug("[Enrichment] Completion notification sent");
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to send completion notification:",
                        error,
                    );
                }
            } else {
                logger.debug(
                    "[Enrichment] Completion notification already sent, skipping",
                );
            }
        }
    } catch (error) {
        logger.error("[Enrichment] Cycle error:", error);

        // Increment system failure counter
        consecutiveSystemFailures++;

        // Circuit breaker: Stop recording system failures after threshold
        // This prevents infinite error loops when state management fails
        if (consecutiveSystemFailures <= MAX_CONSECUTIVE_SYSTEM_FAILURES) {
            // Record system-level failure
            await enrichmentFailureService
                .recordFailure({
                    entityType: "artist", // Generic type for system errors
                    entityId: "system",
                    entityName: "Enrichment System",
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                    errorCode: "SYSTEM_ERROR",
                })
                .catch((err) =>
                    logger.error("[Enrichment] Failed to record failure:", err),
                );
        } else {
            logger.error(
                `[Enrichment] Circuit breaker triggered - ${consecutiveSystemFailures} consecutive system failures. ` +
                    `Suppressing further error recording to prevent infinite loop.`,
            );
        }
    } finally {
        isRunning = false;
    }

    return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued };
}

/**
 * Step 1: Enrich artist metadata
 */
async function enrichArtistsBatch(): Promise<number> {
    // Get concurrency setting from system settings
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency || 1;

    const artists = await prisma.artist.findMany({
        where: {
            OR: [
                { enrichmentStatus: "pending" },
                { enrichmentStatus: "failed" },
            ],
            albums: { some: {} },
        },
        orderBy: { name: "asc" },
        take: ARTIST_BATCH_SIZE,
    });

    if (artists.length === 0) return 0;

    logger.debug(
        `[Artists] Processing ${artists.length} artists (concurrency: ${concurrency})...`,
    );

    // Use p-limit to control concurrency
    const limit = pLimit(concurrency);

    const results = await Promise.allSettled(
        artists.map((artist) =>
            limit(async () => {
                // Check if paused before processing
                if (isPaused) {
                    throw new Error("Paused");
                }

                // Update state with current artist
                await enrichmentStateService.updateState({
                    artists: {
                        current: artist.name,
                    } as any,
                });

                try {
                    // Add timeout to prevent hanging on rate-limited requests
                    // 60s to accommodate multiple sequential API calls (MusicBrainz, Wikidata, Last.fm, Fanart.tv, Deezer, covers)
                    await withTimeout(
                        enrichSimilarArtist(artist),
                        60000, // 60 second max per artist
                        `Timeout enriching artist: ${artist.name}`,
                    );
                    logger.debug(`✓ ${artist.name}`);
                    return artist.name;
                } catch (error) {
                    logger.error(`✗ ${artist.name}:`, error);

                    // Collect failure for batch reporting
                    currentBatchFailures.artists.push({
                        name: artist.name,
                        error:
                            error instanceof Error ?
                                error.message
                            :   String(error),
                    });

                    // Record failure
                    await enrichmentFailureService.recordFailure({
                        entityType: "artist",
                        entityId: artist.id,
                        entityName: artist.name,
                        errorMessage:
                            error instanceof Error ?
                                error.message
                            :   String(error),
                        errorCode:
                            (
                                error instanceof Error &&
                                error.message.includes("Timeout")
                            ) ?
                                "TIMEOUT_ERROR"
                            :   "ENRICHMENT_ERROR",
                        metadata: {
                            mbid: artist.mbid,
                        },
                    });
                    throw error;
                }
            }),
        ),
    );

    // Count successful enrichments
    const processed = results.filter((r) => r.status === "fulfilled").length;

    if (processed > 0) {
        logger.debug(
            `[Artists] Successfully enriched ${processed}/${artists.length} artists`,
        );
    }

    return processed;
}

/**
 * Step 2: Enrich track mood tags from Last.fm
 * Note: No longer waits for artist enrichment - runs in parallel
 */
async function enrichTrackTagsBatch(): Promise<number> {
    // Get concurrency setting from system settings
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency || 1;

    // Note: Nested orderBy on relations doesn't work with isEmpty filtering in Prisma
    // Track tag enrichment doesn't depend on artist enrichment status, so we just order by recency
    // Match both empty array AND null (newly scanned tracks have null, not [])
    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                { lastfmTags: { equals: [] } },
                { lastfmTags: { isEmpty: true } },
                { lastfmTags: { equals: null } },
            ],
        },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
        take: TRACK_BATCH_SIZE,
        orderBy: [{ fileModified: "desc" }],
    });

    if (tracks.length === 0) return 0;

    logger.debug(
        `[Track Tags] Processing ${tracks.length} tracks (concurrency: ${concurrency})...`,
    );

    // Use p-limit to control concurrency
    const limit = pLimit(concurrency);

    const results = await Promise.allSettled(
        tracks.map((track) =>
            limit(async () => {
                // Check if paused before processing
                if (isPaused) {
                    throw new Error("Paused");
                }

                // Update state with current track
                await enrichmentStateService.updateState({
                    tracks: {
                        current: `${track.album.artist.name} - ${track.title}`,
                    } as any,
                });

                try {
                    const artistName = track.album.artist.name;
                    const albumTitle = track.album.title;

                    // Add timeout to prevent hanging on rate-limited requests
                    const trackInfo = await withTimeout(
                        lastFmService.getTrackInfo(artistName, track.title),
                        30000, // 30 second max per track
                        `Timeout enriching track: ${track.title}`,
                    );

                    let moodTags: string[] = [];

                    if (trackInfo?.toptags?.tag) {
                        const allTags = trackInfo.toptags.tag.map(
                            (t: any) => t.name,
                        );
                        moodTags = filterMoodTags(allTags);
                    }

                    // Fallback: if track has no mood tags, try artist tags then album tags
                    if (moodTags.length === 0) {
                        const artistInfo = await withTimeout(
                            lastFmService.getArtistInfo(artistName),
                            15000,
                            `Timeout getting artist info for ${artistName}`,
                        );
                        if (artistInfo?.tags?.tag) {
                            const artistTagNames = artistInfo.tags.tag.map(
                                (t: any) => (typeof t === "string" ? t : t.name),
                            );
                            moodTags = filterMoodTags(artistTagNames);
                        }
                    }

                    if (moodTags.length === 0) {
                        const albumInfo = await withTimeout(
                            lastFmService.getAlbumInfo(artistName, albumTitle),
                            15000,
                            `Timeout getting album info for ${albumTitle}`,
                        );
                        if (albumInfo?.tags?.tag) {
                            const albumTagNames = albumInfo.tags.tag.map(
                                (t: any) => (typeof t === "string" ? t : t.name),
                            );
                            moodTags = filterMoodTags(albumTagNames);
                        }
                    }

                    await prisma.track.update({
                        where: { id: track.id },
                        data: {
                            lastfmTags:
                                moodTags.length > 0 ?
                                    moodTags
                                :   trackInfo === null ?
                                        ["_not_found"]
                                    :   ["_no_mood_tags"],
                        },
                    });

                    if (moodTags.length > 0) {
                        const source = trackInfo?.toptags?.tag ? "track" : "fallback";
                        logger.debug(
                            `   ✓ ${track.title}: [${moodTags
                                .slice(0, 3)
                                .join(", ")}...] (${source})`,
                        );
                    }

                    // Small delay between requests
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    return track.title;
                } catch (error: any) {
                    logger.error(
                        `✗ ${track.title}: ${error?.message || error}`,
                    );

                    // Collect failure for batch reporting
                    currentBatchFailures.tracks.push({
                        name: `${track.album.artist.name} - ${track.title}`,
                        error: error?.message || String(error),
                    });

                    // Record failure
                    await enrichmentFailureService.recordFailure({
                        entityType: "track",
                        entityId: track.id,
                        entityName: `${track.album.artist.name} - ${track.title}`,
                        errorMessage: error?.message || String(error),
                        errorCode:
                            error?.message?.includes("Timeout") ?
                                "TIMEOUT_ERROR"
                            :   "LASTFM_ERROR",
                        metadata: {
                            albumId: track.albumId,
                            filePath: track.filePath,
                        },
                    });
                    throw error;
                }
            }),
        ),
    );

    // Count successful enrichments
    const processed = results.filter((r) => r.status === "fulfilled").length;

    if (processed > 0) {
        logger.debug(
            `[Track Tags] Successfully enriched ${processed}/${tracks.length} tracks`,
        );
    }

    return processed;
}

/**
 * Step 3: Queue pending tracks for audio analysis (Essentia)
 */
async function queueAudioAnalysis(): Promise<number> {
    let totalQueued = 0;

    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "pending",
        },
        select: {
            id: true,
            filePath: true,
            title: true,
            duration: true,
        },
        take: 10,
        orderBy: { fileModified: "desc" },
    });

    if (tracks.length > 0) {
        logger.debug(
            `[Audio Analysis] Queueing ${tracks.length} Prisma mirror track(s) for Essentia...`,
        );

        const redis = getRedis();
        const multi = redis.multi();
        const now = new Date();
        const idsToMark: string[] = [];

        for (const track of tracks) {
            multi.rPush(
                "audio:analysis:queue",
                JSON.stringify({
                    trackId: track.id,
                    filePath: track.filePath,
                    duration: track.duration,
                })
            );
            idsToMark.push(track.id);
        }

        try {
            await multi.exec();
            if (idsToMark.length > 0) {
                await prisma.track.updateMany({
                    where: { id: { in: idsToMark } },
                    data: {
                        analysisStatus: "processing",
                        analysisStartedAt: now,
                    },
                });
            }
            totalQueued += idsToMark.length;
            if (idsToMark.length > 0) {
                logger.debug(
                    ` Queued ${idsToMark.length} Prisma mirror track(s) for audio analysis`,
                );
            }
        } catch (error) {
            logger.error(`   Failed to queue audio analysis batch:`, error);
        }
    }

    try {
        const { isJellyfinMusicSource } = await import("../services/jellyfin");
        if (await isJellyfinMusicSource()) {
            const { queueJellyfinTracksForEssentia } = await import(
                "../services/jellyfinEssentiaQueue"
            );
            totalQueued += await queueJellyfinTracksForEssentia(5);
        }
    } catch (err) {
        logger.warn("[Audio Analysis] Jellyfin Essentia queue skipped:", err);
    }

    return totalQueued;
}

/**
 * Step 4: Queue tracks for CLAP vibe embeddings
 * Only runs if CLAP analyzer is available
 */
const VIBE_QUEUE_BATCH_SIZE = 100; // Cap per cycle to avoid flooding CLAP workers

async function queueVibeEmbeddings(): Promise<number> {
    const tracks = await prisma.$queryRaw<{ id: string; filePath: string }[]>`
        SELECT t.id, t."filePath"
        FROM "Track" t
        LEFT JOIN track_embeddings te ON t.id = te.track_id
        WHERE te.track_id IS NULL
          AND t."filePath" IS NOT NULL
          AND (t."vibeAnalysisStatus" IS NULL OR t."vibeAnalysisStatus" = 'pending')
        LIMIT ${VIBE_QUEUE_BATCH_SIZE}
    `;

    if (tracks.length === 0) {
        return 0;
    }

    const redis = getRedis();
    const multi = redis.multi();
    const now = new Date();
    const ids = tracks.map((t) => t.id);

    for (const track of tracks) {
        multi.rPush(
            "audio:clap:queue",
            JSON.stringify({ trackId: track.id, filePath: track.filePath })
        );
    }

    try {
        await multi.exec();
        await prisma.track.updateMany({
            where: { id: { in: ids } },
            data: {
                vibeAnalysisStatus: "processing",
                vibeAnalysisStartedAt: now,
                vibeAnalysisStatusUpdatedAt: now,
            },
        });
    } catch (error) {
        logger.error(`   Failed to queue vibe embedding batch:`, error);
        return 0;
    }
    return tracks.length;
}

/**
 * Check if enrichment should stop and handle state cleanup if stopping.
 * Returns true if cycle should halt (either stopping or paused).
 */
async function shouldHaltCycle(): Promise<boolean> {
    if (isStopping) {
        await enrichmentStateService.updateState({
            status: "idle",
            currentPhase: null,
        });
        isStopping = false;
        return true;
    }
    return isPaused;
}

/**
 * Run a phase and return result. Returns null if cycle should halt.
 */
async function runPhase(
    phaseName: "artists" | "tracks" | "audio" | "vibe" | "podcasts",
    executor: () => Promise<number>,
): Promise<number | null> {
    await enrichmentStateService.updateState({
        status: "running",
        currentPhase: phaseName,
    });

    const result = await executor();

    if (await shouldHaltCycle()) {
        return null;
    }

    return result;
}

async function executeArtistsPhase(): Promise<number> {
    return enrichArtistsBatch();
}

async function executeMoodTagsPhase(): Promise<number> {
    return enrichTrackTagsBatch();
}

async function executeAudioPhase(): Promise<number> {
    const audioCompletedBefore = await prisma.track.count({
        where: { analysisStatus: "completed" },
    });
    const jellyfinCompletedBefore = await prisma.jellyfinTrackAnalysis.count({
        where: { analysisStatus: "completed" },
    });

    const cleanupResult =
        await audioAnalysisCleanupService.cleanupStaleProcessing();
    if (cleanupResult.reset > 0 || cleanupResult.permanentlyFailed > 0) {
        logger.debug(
            `[Enrichment] Audio analysis cleanup: ${cleanupResult.reset} reset, ${cleanupResult.permanentlyFailed} permanently failed, ${cleanupResult.recovered} recovered`,
        );
    }

    const audioCompletedAfter = await prisma.track.count({
        where: { analysisStatus: "completed" },
    });
    const jellyfinCompletedAfter = await prisma.jellyfinTrackAnalysis.count({
        where: { analysisStatus: "completed" },
    });
    if (
        audioCompletedAfter > audioCompletedBefore ||
        jellyfinCompletedAfter > jellyfinCompletedBefore
    ) {
        audioAnalysisCleanupService.recordSuccess();
    }

    if (audioAnalysisCleanupService.isCircuitOpen()) {
        logger.warn(
            "[Enrichment] Audio analysis circuit breaker OPEN - skipping queue",
        );
        return 0;
    }

    return queueAudioAnalysis();
}

async function executePodcastRefreshPhase(): Promise<number> {
    const podcastCount = await prisma.podcast.count();
    if (podcastCount === 0) return 0;

    // Only refresh once per hour (check oldest lastRefreshed)
    const ONE_HOUR = 60 * 60 * 1000;
    const staleThreshold = new Date(Date.now() - ONE_HOUR);
    const stalePodcasts = await prisma.podcast.findMany({
        where: {
            lastRefreshed: { lt: staleThreshold },
        },
        select: { id: true, title: true },
    });

    if (stalePodcasts.length === 0) return 0;

    logger.debug(`[Enrichment] Refreshing ${stalePodcasts.length} podcast feeds...`);

    const { refreshPodcastFeed } = await import("../services/podcastFeedRefresh");
    let refreshed = 0;

    for (const podcast of stalePodcasts) {
        if (isPaused || isStopping) break;

        try {
            const result = await withTimeout(
                refreshPodcastFeed(podcast.id),
                30000,
                `Timeout refreshing podcast: ${podcast.title}`,
            );
            if (result.newEpisodesCount > 0) {
                logger.debug(`   [Podcast] ${podcast.title}: ${result.newEpisodesCount} new episodes`);
            }
            refreshed++;
        } catch (error) {
            logger.error(`   [Podcast] Failed to refresh ${podcast.title}:`, error);
        }
    }

    if (refreshed > 0) {
        logger.debug(`[Enrichment] Refreshed ${refreshed} podcast feeds`);
    }

    return refreshed;
}

async function executeVibePhase(): Promise<number> {
    const features = await featureDetection.getFeatures();
    if (!features.vibeEmbeddings) {
        return 0;
    }

    const audioProcessing = await prisma.track.count({
        where: { analysisStatus: "processing" },
    });
    const audioQueue = await getRedis().lLen("audio:analysis:queue");
    if (audioProcessing > 0 || audioQueue > 0) {
        logger.debug(
            `[Enrichment] Skipping vibe phase - audio still running (${audioProcessing} processing, ${audioQueue} queued)`,
        );
        return 0;
    }

    const { reset, permanentlyFailed } =
        await vibeAnalysisCleanupService.cleanupStaleProcessing();
    if (reset > 0 || permanentlyFailed > 0) {
        logger.debug(
            `[ENRICHMENT] Vibe cleanup: ${reset} reset, ${permanentlyFailed} permanently failed`
        );
    }

    if (vibeAnalysisCleanupService.isCircuitOpen()) {
        logger.warn(
            "[Enrichment] Vibe embedding circuit breaker OPEN - skipping queue"
        );
        return 0;
    }

    const result = await queueVibeEmbeddings();
    if (result > 0) {
        logger.debug(`[ENRICHMENT] Queued ${result} tracks for vibe embedding`);
    }

    return result;
}

/**
 * Get comprehensive enrichment progress
 *
 * Returns separate progress for:
 * - Artists & Track Tags: "Core" enrichment (must complete before app is fully usable)
 * - Audio Analysis: "Background" enrichment (runs in separate container, non-blocking)
 *
 * When Jellyfin is music source: uses JellyfinTrackMetadata for Mood Tags instead of native Track.
 */
export async function getEnrichmentProgress() {
    const { isJellyfinMusicSource } = await import("../services/jellyfin");
    const isJellyfin = await isJellyfinMusicSource();

    let artistTotal = 0;
    let artistCompleted = 0;
    let artistPending = 0;
    let artistFailed = 0;
    let trackTotal = 0;
    let trackTagsEnriched = 0;
    let jellyfinJobStatus: {
        status: string;
        startedAt?: number;
        lastSynced?: number;
        lastEnriched?: number;
        lastError?: string;
    } | null = null;

    if (isJellyfin) {
        // Jellyfin: use JellyfinTrackMetadata for Mood Tags
        const [jellyfinTotal, jellyfinEnriched, jobState] = await Promise.all([
            prisma.jellyfinTrackMetadata.count(),
            prisma.jellyfinTrackMetadata.count({
                where: { lastfmTags: { isEmpty: false } },
            }),
            (async () => {
                try {
                    const { getJobStatus } = await import("../services/jellyfinMetadataJob");
                    return await getJobStatus();
                } catch {
                    return null;
                }
            })(),
        ]);
        trackTotal = jellyfinTotal;
        trackTagsEnriched = jellyfinEnriched;
        // Jellyfin artists are enriched on-demand when viewing - no bulk progress
        artistTotal = 0;
        artistCompleted = 0;
        artistPending = 0;
        artistFailed = 0;
        if (jobState) {
            jellyfinJobStatus = {
                status: jobState.status,
                startedAt: jobState.startedAt,
                lastSynced: jobState.lastSynced,
                lastEnriched: jobState.lastEnriched,
                lastError: jobState.lastError,
            };
        }
    } else {
        // Native: use Artist and Track tables
        const artistCounts = await prisma.artist.groupBy({
            by: ["enrichmentStatus"],
            _count: true,
        });
        artistTotal = artistCounts.reduce((sum, s) => sum + s._count, 0);
        artistCompleted =
            artistCounts.find((s) => s.enrichmentStatus === "completed")?._count || 0;
        artistPending =
            artistCounts.find((s) => s.enrichmentStatus === "pending")?._count || 0;
        artistFailed =
            artistCounts.find((s) => s.enrichmentStatus === "failed")?._count || 0;

        trackTotal = await prisma.track.count();
        trackTagsEnriched = await prisma.track.count({
            where: { lastfmTags: { isEmpty: false } },
        });
    }

    // Audio analysis progress (background task)
    const audioCompleted = await prisma.track.count({
        where: { analysisStatus: "completed" },
    });
    const audioPending = await prisma.track.count({
        where: { analysisStatus: "pending" },
    });
    const audioProcessing = await prisma.track.count({
        where: { analysisStatus: "processing" },
    });
    const audioFailed = await prisma.track.count({
        where: { analysisStatus: "failed" },
    });

    // CLAP embedding progress (for vibe similarity)
    const [clapEmbeddingCount, clapProcessing, clapQueueLength, clapFailedCount] = await Promise.all([
        prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(*) as count FROM track_embeddings
        `,
        prisma.track.count({
            where: { vibeAnalysisStatus: "processing" },
        }),
        getRedis().lLen("audio:clap:queue"),
        prisma.enrichmentFailure.count({
            where: { entityType: "vibe", resolved: false, skipped: false },
        }),
    ]);
    const clapCompleted = Number(clapEmbeddingCount[0]?.count || 0);
    const clapFailed = clapFailedCount;

    // Core enrichment is complete when artists and track tags are done
    // Audio analysis is separate - it runs in background and doesn't block
    const coreComplete =
        artistPending === 0 && trackTotal - trackTagsEnriched === 0;

    return {
        // Music source: native (prisma) vs jellyfin
        musicSource: isJellyfin ? "jellyfin" : "native",
        jellyfinJobStatus: jellyfinJobStatus ?? undefined,

        // Core enrichment (blocking)
        artists: {
            total: artistTotal,
            completed: artistCompleted,
            pending: artistPending,
            failed: artistFailed,
            progress:
                artistTotal > 0 ?
                    Math.round((artistCompleted / artistTotal) * 100)
                :   0,
        },
        trackTags: {
            total: trackTotal,
            enriched: trackTagsEnriched,
            pending: trackTotal - trackTagsEnriched,
            progress:
                trackTotal > 0 ?
                    Math.round((trackTagsEnriched / trackTotal) * 100)
                :   0,
        },

        // Background enrichment (non-blocking, runs in audio-analyzer container)
        audioAnalysis: {
            total: trackTotal,
            completed: audioCompleted,
            pending: audioPending,
            processing: audioProcessing,
            failed: audioFailed,
            progress:
                trackTotal > 0 ?
                    Math.round((audioCompleted / trackTotal) * 100)
                :   0,
            isBackground: true, // Flag to indicate this runs separately
        },

        // CLAP embeddings (for vibe similarity search)
        clapEmbeddings: {
            total: trackTotal,
            completed: clapCompleted,
            pending: trackTotal - clapCompleted - clapFailed,
            processing: clapProcessing,
            failed: clapFailed,
            progress:
                trackTotal > 0 ?
                    Math.round((clapCompleted / trackTotal) * 100)
                :   0,
            isBackground: true,
        },

        // Overall status
        coreComplete, // True when artists + track tags are done
        isFullyComplete:
            coreComplete &&
            audioPending === 0 &&
            audioProcessing === 0 &&
            clapProcessing === 0 &&
            clapQueueLength === 0 &&
            clapCompleted + clapFailed >= trackTotal,
    };
}

/**
 * Trigger an immediate enrichment cycle (non-blocking)
 * Used when new tracks are added and we want to collect mood tags right away
 * instead of waiting for the 30s background interval
 */
export async function triggerEnrichmentNow(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("[Enrichment] Triggering immediate enrichment cycle...");

    // Reset pause state when triggering enrichment
    isPaused = false;

    // Set flag to bypass isRunning check (prevents race conditions)
    immediateEnrichmentRequested = true;

    return runEnrichmentCycle(false);
}

 /**
  * Re-run artist enrichment only (from the beginning)
  * Resets artist statuses and starts sequential enrichment from Phase 1
  */
 export async function reRunArtistsOnly(): Promise<{ count: number }> {
     logger.debug("[Enrichment] Re-running artist enrichment only...");

     const result = await resetArtistsOnly();

     logger.debug("[Enrichment] Starting sequential enrichment from artists phase...");
     isPaused = false;
     immediateEnrichmentRequested = true;

     // Run full cycle but it will stop after artists phase if paused/stopped
     const cycleResult = await runEnrichmentCycle(false);

     return { count: result.count };
 }

 /**
  * Re-run mood tags only (from the beginning)
  * Resets mood tags and starts sequential enrichment from Phase 1
  */
 export async function reRunMoodTagsOnly(): Promise<{ count: number }> {
     logger.debug("[Enrichment] Re-running mood tags only...");

     const result = await resetMoodTagsOnly();

     logger.debug("[Enrichment] Starting sequential enrichment from mood tags phase...");
     isPaused = false;
     immediateEnrichmentRequested = true;

     const cycleResult = await runEnrichmentCycle(false);

     return { count: result.count };
 }

 /**
  * Re-run audio analysis only
  * Cleans up stale jobs and queues for audio analysis
  */
 export async function reRunAudioAnalysisOnly(): Promise<number> {
     logger.debug("[Enrichment] Re-running audio analysis only...");

     await audioAnalysisCleanupService.cleanupStaleProcessing();

     const tracks = await prisma.track.findMany({
         where: { analysisStatus: "pending" },
         select: { id: true },
     });

     logger.debug(`[Enrichment] Found ${tracks.length} tracks pending audio analysis`);

     const queued = await queueAudioAnalysis();

     logger.debug(`[Enrichment] Queued ${queued} tracks for audio analysis`);

     return queued;
 }

 /**
  * Re-run vibe embeddings only
  * Cleans up stale jobs and queues for vibe embeddings
  */
 export async function reRunVibeEmbeddingsOnly(): Promise<number> {
     logger.debug("[Enrichment] Re-running vibe embeddings only...");

     const features = await featureDetection.getFeatures();
     if (!features.vibeEmbeddings) {
         logger.debug("[Enrichment] Vibe embeddings not available, skipping");
         return 0;
     }

     await vibeAnalysisCleanupService.cleanupStaleProcessing();

     const queued = await queueVibeEmbeddings();

     logger.debug(`[Enrichment] Queued ${queued} tracks for vibe embeddings`);

     return queued;
 }
