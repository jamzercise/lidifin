import type { Router } from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { startOfWeek, endOfWeek } from "date-fns";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import { lastFmService } from "../../services/lastfm";
import { lidarrService } from "../../services/lidarr";
import { discoverQueue, scanQueue } from "../../workers/queues";
import { getSystemSettings } from "../../utils/systemSettings";

/**
 * Discover Weekly job orchestration: batch-status, generate, status, current, rebuild.
 */
export function registerJobsRoutes(router: Router): void {
    // GET /discover/batch-status - Check if there's an active batch being processed
    router.get("/batch-status", async (req, res) => {
        try {
            const userId = req.user!.id;

            // Find any active batch for this user
            const activeBatch = await prisma.discoveryBatch.findFirst({
                where: {
                    userId,
                    status: { in: ["downloading", "scanning"] },
                },
                include: {
                    jobs: {
                        select: {
                            id: true,
                            status: true,
                            error: true,
                            metadata: true,
                        },
                    },
                },
                orderBy: { createdAt: "desc" },
            });

            if (!activeBatch) {
                return res.json({
                    active: false,
                    status: null,
                    progress: null,
                });
            }

            const completedJobs = activeBatch.jobs.filter(
                (j) => j.status === "completed"
            ).length;
            const failedJobs = activeBatch.jobs.filter(
                (j) => j.status === "failed" || j.status === "exhausted"
            ).length;
            const totalJobs = activeBatch.jobs.length;
            const progress =
                totalJobs > 0
                    ? Math.round(((completedJobs + failedJobs) / totalJobs) * 100)
                    : 0;

            // Per-album rows so the UI can show live status during the batch
            const albums = activeBatch.jobs.map((j) => {
                const meta = j.metadata as any;
                return {
                    id: j.id,
                    artist: meta?.artistName || "Unknown",
                    album: meta?.albumTitle || "Unknown",
                    status: j.status,
                    error: j.error,
                };
            });

            res.json({
                active: true,
                status: activeBatch.status,
                batchId: activeBatch.id,
                progress,
                completed: completedJobs,
                failed: failedJobs,
                total: totalJobs,
                albums,
            });
        } catch (error) {
            logger.error("Get batch status error:", error);
            res.status(500).json({ error: "Failed to get batch status" });
        }
    });

    // POST /discover/generate — enqueue Discover Weekly work on the BullMQ discover queue
    router.post("/generate", async (req, res) => {
        try {
            const userId = req.user!.id;

            // Check for existing active batch
            const existingBatch = await prisma.discoveryBatch.findFirst({
                where: {
                    userId,
                    status: { in: ["downloading", "scanning"] },
                },
            });

            if (existingBatch) {
                return res.status(409).json({
                    error: "Generation already in progress",
                    batchId: existingBatch.id,
                    status: existingBatch.status,
                });
            }

            logger.debug(`\n Queuing Discover Weekly generation for user ${userId}`);

            // Add generation job to queue
            const job = await discoverQueue.add("discover-weekly", { userId });

            res.json({
                message: "Discover Weekly generation started",
                jobId: job.id,
            });
        } catch (error) {
            logger.error("Generate Discover Weekly error:", error);
            res.status(500).json({ error: "Failed to start generation" });
        }
    });

    // GET /discover/generate/status/:jobId - Check generation job status
    router.get("/generate/status/:jobId", async (req, res) => {
        try {
            const job = await discoverQueue.getJob(req.params.jobId);

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
            });
        } catch (error) {
            logger.error("Get generation status error:", error);
            res.status(500).json({ error: "Failed to get job status" });
        }
    });

    // GET /discover/current - Get current week's Discover Weekly playlist
    router.get("/current", async (req, res) => {
        try {
            const userId = req.user!.id;

            const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
            const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 }); // Sunday

            // Get all discovery albums for this week with their tracks
            const discoveryAlbums = await prisma.discoveryAlbum.findMany({
                where: {
                    userId,
                    weekStartDate: weekStart,
                    status: { in: ["ACTIVE", "LIKED"] },
                },
                include: {
                    tracks: true, // DiscoveryTrack records (trackId is just a string, not a relation)
                },
                orderBy: { downloadedAt: "asc" },
            });

            // Get unavailable albums for this week (show full replacement chain)
            const unavailableAlbums = await prisma.unavailableAlbum.findMany({
                where: {
                    userId,
                    weekStartDate: weekStart,
                },
                orderBy: [
                    { originalAlbumId: "asc" }, // Group by original album
                    { attemptNumber: "asc" }, // Then sort by attempt number
                ],
            });

            // Build track list from DiscoveryTrack records (the actual selected tracks)
            const tracks = [];

            for (const discoveryAlbum of discoveryAlbums) {
                // If we have DiscoveryTrack records, use them (the actual selected tracks)
                if (discoveryAlbum.tracks && discoveryAlbum.tracks.length > 0) {
                    // Fetch all tracks in one query using their IDs
                    const trackIds = discoveryAlbum.tracks
                        .map((dt) => dt.trackId)
                        .filter((id): id is string => id !== null);

                    if (trackIds.length > 0) {
                        const libraryTracks = await prisma.track.findMany({
                            where: { id: { in: trackIds } },
                            include: { album: { include: { artist: true } } },
                        });

                        // Create a map for quick lookup
                        const trackMap = new Map(
                            libraryTracks.map((t) => [t.id, t])
                        );

                        for (const dt of discoveryAlbum.tracks) {
                            const track = dt.trackId
                                ? trackMap.get(dt.trackId)
                                : null;
                            if (track) {
                                tracks.push({
                                    id: track.id,
                                    title: track.title,
                                    artist: discoveryAlbum.artistName,
                                    album: discoveryAlbum.albumTitle,
                                    albumId: discoveryAlbum.rgMbid,
                                    isLiked: discoveryAlbum.status === "LIKED",
                                    likedAt: discoveryAlbum.likedAt,
                                    similarity: discoveryAlbum.similarity,
                                    tier: discoveryAlbum.tier,
                                    coverUrl: track.album?.coverUrl,
                                    available: true,
                                    duration: track.duration,
                                });
                            }
                        }
                    }
                }

                // Fallback: No DiscoveryTrack records or no valid trackIds, find ONE track from library
                if (
                    tracks.filter((t) => t.album === discoveryAlbum.albumTitle)
                        .length === 0
                ) {
                    const album = await prisma.album.findFirst({
                        where: {
                            title: discoveryAlbum.albumTitle,
                            artist: { name: discoveryAlbum.artistName },
                        },
                        include: {
                            artist: true,
                            tracks: { take: 1, orderBy: { trackNo: "asc" } },
                        },
                    });

                    if (album && album.tracks.length > 0) {
                        const track = album.tracks[0];
                        tracks.push({
                            id: track.id,
                            title: track.title,
                            artist: discoveryAlbum.artistName,
                            album: discoveryAlbum.albumTitle,
                            albumId: discoveryAlbum.rgMbid,
                            isLiked: discoveryAlbum.status === "LIKED",
                            likedAt: discoveryAlbum.likedAt,
                            similarity: discoveryAlbum.similarity,
                            tier: discoveryAlbum.tier,
                            coverUrl: album.coverUrl,
                            available: true,
                            duration: track.duration,
                        });
                    } else {
                        // Album not in library yet (downloading/pending)
                        tracks.push({
                            id: `pending-${discoveryAlbum.id}`,
                            title: `${discoveryAlbum.albumTitle} (pending import)`,
                            artist: discoveryAlbum.artistName,
                            album: discoveryAlbum.albumTitle,
                            albumId: discoveryAlbum.rgMbid,
                            isLiked: discoveryAlbum.status === "LIKED",
                            likedAt: discoveryAlbum.likedAt,
                            similarity: discoveryAlbum.similarity,
                            tier: discoveryAlbum.tier,
                            coverUrl: null,
                            available: false,
                            isPending: true,
                            duration: 0,
                        });
                    }
                }
            }

            // Get the list of successfully downloaded album MBIDs from discoveryAlbums
            const successfulMbids = new Set(discoveryAlbums.map((da) => da.rgMbid));

            // Filter unavailable albums:
            // 1. Remove albums that successfully downloaded (have DiscoveryAlbum record)
            // 2. Remove albums that the user now owns (in Album table)
            const filteredUnavailable: typeof unavailableAlbums = [];
            for (const album of unavailableAlbums) {
                // Skip if this album successfully downloaded this week
                if (successfulMbids.has(album.albumMbid)) {
                    continue;
                }

                // Skip if album exists in user's library by artist+title (normalized match)
                const normalizedArtist = album.artistName.toLowerCase().trim();
                const normalizedAlbum = album.albumTitle
                    .toLowerCase()
                    .replace(/\(.*?\)/g, "") // Remove parenthetical content
                    .replace(/\[.*?\]/g, "") // Remove bracketed content
                    .trim();

                const existsInLibrary = await prisma.album.findFirst({
                    where: {
                        OR: [
                            { rgMbid: album.albumMbid },
                            {
                                title: {
                                    contains: normalizedAlbum,
                                    mode: "insensitive",
                                },
                                artist: {
                                    name: {
                                        contains: normalizedArtist,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        ],
                    },
                });

                if (existsInLibrary) {
                    continue; // User already owns this album, don't show as unavailable
                }

                filteredUnavailable.push(album);
            }

            // Format unavailable albums
            const unavailable = filteredUnavailable.map((album) => ({
                id: `unavailable-${album.id}`,
                title: album.albumTitle,
                artist: album.artistName,
                album: album.albumTitle,
                albumId: album.albumMbid,
                similarity: album.similarity,
                tier: album.tier,
                previewUrl: album.previewUrl,
                deezerTrackId: album.deezerTrackId,
                deezerAlbumId: album.deezerAlbumId,
                attemptNumber: album.attemptNumber,
                originalAlbumId: album.originalAlbumId,
                available: false,
            }));

            try {
                logger.debug(`\nDiscover Weekly API Response:`);
                logger.debug(`  Total tracks: ${tracks.length}`);
                logger.debug(`  Unavailable albums: ${unavailable.length}`);
                if (unavailable.length > 0 && unavailable.length <= 20) {
                    logger.debug(`  Unavailable albums with previews:`);
                    unavailable.slice(0, 5).forEach((album, i) => {
                        logger.debug(
                            `    ${i + 1}. ${album.artist} - ${album.album} [${
                                album.previewUrl ? "HAS PREVIEW" : "NO PREVIEW"
                            }]`
                        );
                    });
                    if (unavailable.length > 5) {
                        logger.debug(`    ... and ${unavailable.length - 5} more`);
                    }
                }
            } catch (err) {
                logger.error("Error logging discover response:", err);
            }

            // If no playable tracks, include batch context so the UI can explain what happened
            let batchContext: any = null;
            if (tracks.length === 0) {
                const latestBatch = await prisma.discoveryBatch.findFirst({
                    where: {
                        userId,
                        OR: [
                            { weekStart },
                            { status: { in: ["downloading", "scanning"] } },
                        ],
                    },
                    include: { jobs: true },
                    orderBy: { createdAt: "desc" },
                });

                if (latestBatch) {
                    const completedJobs = latestBatch.jobs.filter(j => j.status === "completed");
                    const failedJobs = latestBatch.jobs.filter(j => j.status === "failed" || j.status === "exhausted");
                    const pendingJobs = latestBatch.jobs.filter(j => j.status === "pending" || j.status === "processing");

                    batchContext = {
                        batchId: latestBatch.id,
                        status: latestBatch.status,
                        errorMessage: latestBatch.errorMessage,
                        createdAt: latestBatch.createdAt,
                        completedAt: latestBatch.completedAt,
                        totalJobs: latestBatch.jobs.length,
                        completedJobs: completedJobs.length,
                        failedJobs: failedJobs.length,
                        pendingJobs: pendingJobs.length,
                        recommendedAlbums: latestBatch.jobs.map(j => {
                            const meta = j.metadata as any;
                            return {
                                id: j.id,
                                artist: meta?.artistName || "Unknown",
                                album: meta?.albumTitle || "Unknown",
                                status: j.status,
                                error: j.error,
                            };
                        }),
                    };
                }
            }

            res.json({
                weekStart,
                weekEnd,
                tracks,
                unavailable,
                totalCount: tracks.length,
                unavailableCount: unavailable.length,
                batchContext,
            });
        } catch (error) {
            logger.error("Get current Discover Weekly error:", error);
            res.status(500).json({
                error: "Failed to get Discover Weekly playlist",
            });
        }
    });

    // POST /discover/rebuild - Retry building playlist from an existing batch
    router.post("/rebuild", async (req, res) => {
        try {
            const userId = req.user!.id;
            const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });

            const batch = await prisma.discoveryBatch.findFirst({
                where: {
                    userId,
                    OR: [
                        { weekStart },
                        { status: { in: ["scanning", "downloading"] } },
                    ],
                },
                include: { jobs: true },
                orderBy: { createdAt: "desc" },
            });

            if (!batch) {
                return res.status(404).json({ error: "No batch found for this week" });
            }

            const pendingJobs = batch.jobs.filter(
                j => j.status === "pending" || j.status === "processing"
            );
            const completedJobs = batch.jobs.filter(j => j.status === "completed");

            // Force-fail any remaining pending/processing jobs
            if (pendingJobs.length > 0) {
                await prisma.downloadJob.updateMany({
                    where: {
                        discoveryBatchId: batch.id,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "failed",
                        error: "Force-completed by rebuild",
                        completedAt: new Date(),
                    },
                });
                logger.debug(`[Rebuild] Force-failed ${pendingJobs.length} pending jobs`);
            }

            if (completedJobs.length === 0) {
                // No completed downloads — try reconciling with what's in the library
                logger.debug(`[Rebuild] No completed jobs, attempting scan reconciliation`);
                await prisma.discoveryBatch.update({
                    where: { id: batch.id },
                    data: { status: "scanning" },
                });

                await scanQueue.add("scan", {
                    type: "full",
                    source: "discover-weekly-completion",
                    discoveryBatchId: batch.id,
                });

                return res.json({
                    message: "Triggered rescan and playlist rebuild",
                    batchId: batch.id,
                });
            }

            // Set batch to scanning and trigger buildFinalPlaylist via scan
            await prisma.discoveryBatch.update({
                where: { id: batch.id },
                data: { status: "scanning" },
            });

            await scanQueue.add("scan", {
                type: "full",
                source: "discover-weekly-completion",
                discoveryBatchId: batch.id,
            });

            logger.debug(`[Rebuild] Triggered scan + playlist build for batch ${batch.id}`);

            res.json({
                message: "Rebuild started — rescanning and building playlist",
                batchId: batch.id,
                completedJobs: completedJobs.length,
            });
        } catch (error: any) {
            logger.error("Rebuild Discover Weekly error:", error);
            res.status(500).json({ error: "Failed to rebuild playlist" });
        }
    });

    // POST /discover/cancel - Cancel the user's active generation batch
    router.post("/cancel", async (req, res) => {
        try {
            const userId = req.user!.id;
            const { discoverWeeklyService } = await import(
                "../../services/discoverWeekly"
            );
            const result = await discoverWeeklyService.cancelActiveBatch(userId);
            if (!result.success) {
                return res.status(404).json({ error: result.error });
            }
            res.json({
                message: "Generation cancelled",
                cancelledJobs: result.cancelledJobs ?? 0,
            });
        } catch (error) {
            logger.error("Cancel discovery batch error:", error);
            res.status(500).json({ error: "Failed to cancel generation" });
        }
    });

    // POST /discover/retry-album - Retry a single failed discovery album
    router.post("/retry-album", async (req, res) => {
        try {
            const userId = req.user!.id;
            const { jobId } = req.body as { jobId?: string };
            if (!jobId) {
                return res.status(400).json({ error: "jobId is required" });
            }
            const { discoverWeeklyService } = await import(
                "../../services/discoverWeekly"
            );
            const result = await discoverWeeklyService.retryAlbumJob(
                userId,
                jobId
            );
            if (!result.success) {
                const status = result.error?.includes("not found") ? 404 : 400;
                return res.status(status).json({ error: result.error });
            }
            res.json({ message: "Retry started" });
        } catch (error) {
            logger.error("Retry discovery album error:", error);
            res.status(500).json({ error: "Failed to retry album" });
        }
    });
}
