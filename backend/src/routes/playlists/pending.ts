import type { Router } from "express";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { sessionLog } from "../../utils/playlistLogger";

export function registerPlaylistPendingRoutes(router: Router): void {
    router.get("/:id/pending", async (req, res) => {
        try {
            const userId = req.user!.id;
            const playlistId = req.params.id;

            // Check ownership or public access
            const playlist = await prisma.playlist.findUnique({
                where: { id: playlistId },
            });

            if (!playlist) {
                return res.status(404).json({ error: "Playlist not found" });
            }

            if (playlist.userId !== userId && !playlist.isPublic) {
                return res.status(403).json({ error: "Access denied" });
            }

            const pendingTracks = await prisma.playlistPendingTrack.findMany({
                where: { playlistId },
                orderBy: { sort: "asc" },
            });

            res.json({
                count: pendingTracks.length,
                tracks: pendingTracks.map((t) => ({
                    id: t.id,
                    artist: t.spotifyArtist,
                    title: t.spotifyTitle,
                    album: t.spotifyAlbum,
                    position: t.sort,
                    previewUrl: t.deezerPreviewUrl,
                })),
                spotifyPlaylistId: playlist.spotifyPlaylistId,
            });
        } catch (error) {
            logger.error("Get pending tracks error:", error);
            res.status(500).json({ error: "Failed to get pending tracks" });
        }
    });

    /**
     * DELETE /playlists/:id/pending/:trackId
     * Remove a pending track (user decides they don't want to wait for it)
     */
    router.delete("/:id/pending/:trackId", async (req, res) => {
        try {
            const userId = req.user!.id;
            const { id: playlistId, trackId: pendingTrackId } = req.params;

            // Check ownership
            const playlist = await prisma.playlist.findUnique({
                where: { id: playlistId },
            });

            if (!playlist) {
                return res.status(404).json({ error: "Playlist not found" });
            }

            if (playlist.userId !== userId) {
                return res.status(403).json({ error: "Access denied" });
            }

            await prisma.playlistPendingTrack.delete({
                where: { id: pendingTrackId },
            });

            res.json({ message: "Pending track removed" });
        } catch (error: any) {
            if (error.code === "P2025") {
                return res
                    .status(404)
                    .json({ error: "Pending track not found" });
            }
            logger.error("Delete pending track error:", error);
            res.status(500).json({ error: "Failed to delete pending track" });
        }
    });

    /**
     * GET /playlists/:id/pending/:trackId/preview
     * Get a fresh Deezer preview URL for a pending track (since they expire)
     */
    router.get("/:id/pending/:trackId/preview", async (req, res) => {
        try {
            const { trackId: pendingTrackId } = req.params;

            // Get the pending track
            const pendingTrack = await prisma.playlistPendingTrack.findUnique({
                where: { id: pendingTrackId },
            });

            if (!pendingTrack) {
                return res
                    .status(404)
                    .json({ error: "Pending track not found" });
            }

            // Fetch fresh Deezer preview URL
            const { deezerService } = await import("../../services/deezer");
            const previewUrl = await deezerService.getTrackPreview(
                pendingTrack.spotifyArtist,
                pendingTrack.spotifyTitle,
            );

            if (!previewUrl) {
                return res
                    .status(404)
                    .json({ error: "No preview available on Deezer" });
            }

            // Update the stored preview URL for future use
            await prisma.playlistPendingTrack.update({
                where: { id: pendingTrackId },
                data: { deezerPreviewUrl: previewUrl },
            });

            res.json({ previewUrl });
        } catch (error: any) {
            logger.error("Get preview URL error:", error);
            res.status(500).json({ error: "Failed to get preview URL" });
        }
    });

    /**
     * POST /playlists/:id/pending/:trackId/retry
     * Retry downloading a failed/pending track from Soulseek
     * Returns immediately and downloads in background
     */
    router.post("/:id/pending/:trackId/retry", async (req, res) => {
        try {
            const userId = req.user!.id;
            const { id: playlistId, trackId: pendingTrackId } = req.params;

            sessionLog(
                "PENDING-RETRY",
                `Request: userId=${userId} playlistId=${playlistId} pendingTrackId=${pendingTrackId}`,
            );

            // Check ownership
            const playlist = await prisma.playlist.findUnique({
                where: { id: playlistId },
            });

            if (!playlist) {
                sessionLog(
                    "PENDING-RETRY",
                    `Playlist not found: ${playlistId}`,
                    "WARN",
                );
                return res.status(404).json({ error: "Playlist not found" });
            }

            if (playlist.userId !== userId) {
                sessionLog(
                    "PENDING-RETRY",
                    `Access denied: playlistId=${playlistId} userId=${userId}`,
                    "WARN",
                );
                return res.status(403).json({ error: "Access denied" });
            }

            // Get the pending track
            const pendingTrack = await prisma.playlistPendingTrack.findUnique({
                where: { id: pendingTrackId },
            });

            if (!pendingTrack) {
                sessionLog(
                    "PENDING-RETRY",
                    `Pending track not found: ${pendingTrackId}`,
                    "WARN",
                );
                return res
                    .status(404)
                    .json({ error: "Pending track not found" });
            }

            sessionLog(
                "PENDING-RETRY",
                `Pending track: artist="${pendingTrack.spotifyArtist}" title="${pendingTrack.spotifyTitle}" album="${pendingTrack.spotifyAlbum}"`,
            );

            // Create a DownloadJob so this retry appears in Activity (active/history)
            const retryTargetId =
                pendingTrack.albumMbid ||
                pendingTrack.artistMbid ||
                `pendingTrack:${pendingTrack.id}`;

            const downloadJob = await prisma.downloadJob.create({
                data: {
                    userId,
                    subject: `${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
                    type: "track",
                    targetMbid: retryTargetId,
                    artistMbid: pendingTrack.artistMbid,
                    status: "processing",
                    attempts: 1,
                    startedAt: new Date(),
                    metadata: {
                        downloadType: "pending-track-retry",
                        source: "soulseek",
                        playlistId,
                        pendingTrackId,
                        spotifyArtist: pendingTrack.spotifyArtist,
                        spotifyTitle: pendingTrack.spotifyTitle,
                        spotifyAlbum: pendingTrack.spotifyAlbum,
                        albumMbid: pendingTrack.albumMbid,
                    },
                },
            });

            sessionLog(
                "PENDING-RETRY",
                `Created download job: downloadJobId=${downloadJob.id} target=${retryTargetId}`,
            );

            // Import soulseek service and try to download
            const { soulseekService } = await import("../../services/soulseek");
            const { getSystemSettings } =
                await import("../../utils/systemSettings");

            const settings = await getSystemSettings();
            if (!settings?.musicPath) {
                sessionLog(
                    "PENDING-RETRY",
                    `Music path not configured`,
                    "WARN",
                );
                await prisma.downloadJob.update({
                    where: { id: downloadJob.id },
                    data: {
                        status: "failed",
                        error: "Music path not configured",
                        completedAt: new Date(),
                    },
                });
                return res
                    .status(400)
                    .json({ error: "Music path not configured" });
            }

            if (!settings?.soulseekUsername || !settings?.soulseekPassword) {
                sessionLog(
                    "PENDING-RETRY",
                    `Soulseek credentials not configured`,
                    "WARN",
                );
                await prisma.downloadJob.update({
                    where: { id: downloadJob.id },
                    data: {
                        status: "failed",
                        error: "Soulseek credentials not configured",
                        completedAt: new Date(),
                    },
                });
                return res
                    .status(400)
                    .json({ error: "Soulseek credentials not configured" });
            }

            // Use a better album name if possible - extract from stored title or use artist name
            const albumName =
                pendingTrack.spotifyAlbum !== "Unknown Album"
                    ? pendingTrack.spotifyAlbum
                    : pendingTrack.spotifyArtist; // Use artist as fallback folder name

            logger.debug(
                `[Retry] Starting download for: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
            );
            sessionLog(
                "PENDING-RETRY",
                `Search: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
            );

            // First do a quick search to see if track is available (15s timeout)
            // This way we can tell the user immediately if it's not found
            const searchResult = await soulseekService.searchTrack(
                pendingTrack.spotifyArtist,
                pendingTrack.spotifyTitle,
            );

            if (!searchResult.found || searchResult.allMatches.length === 0) {
                logger.debug(`[Retry] No results found on Soulseek`);
                sessionLog(
                    "PENDING-RETRY",
                    `No results found on Soulseek`,
                    "INFO",
                );

                await prisma.downloadJob.update({
                    where: { id: downloadJob.id },
                    data: {
                        status: "failed",
                        error: "No matching files found",
                        completedAt: new Date(),
                    },
                });

                return res.status(200).json({
                    success: false,
                    message: "Track not found on Soulseek",
                    error: "No matching files found",
                });
            }

            logger.debug(
                `[Retry] ✓ Found ${searchResult.allMatches.length} results, starting download in background`,
            );
            sessionLog(
                "PENDING-RETRY",
                `Found ${searchResult.allMatches.length} candidate(s); starting background download`,
            );

            // Return immediately - download happens in background
            res.json({
                success: true,
                message: "Download started",
                note: `Found ${searchResult.allMatches.length} sources. Downloading... Track will appear after scan.`,
                downloadJobId: downloadJob.id,
            });

            // Start download in background (don't await)
            soulseekService
                .downloadBestMatch(
                    pendingTrack.spotifyArtist,
                    pendingTrack.spotifyTitle,
                    albumName,
                    searchResult.allMatches,
                    settings.musicPath,
                )
                .then(async (result) => {
                    if (result.success) {
                        logger.debug(
                            `[Retry] ✓ Download complete: ${result.filePath}`,
                        );
                        sessionLog(
                            "PENDING-RETRY",
                            `Download complete: filePath=${result.filePath}`,
                        );

                        await prisma.downloadJob.update({
                            where: { id: downloadJob.id },
                            data: {
                                status: "completed",
                                completedAt: new Date(),
                                metadata: {
                                    ...(downloadJob.metadata as any),
                                    filePath: result.filePath,
                                },
                            },
                        });

                        // Trigger a library scan to add the track and reconcile pending
                        try {
                            const { scanQueue } =
                                await import("../../workers/queues");
                            const scanJob = await scanQueue.add(
                                "scan",
                                {
                                    userId,
                                    source: "retry-pending-track",
                                    albumMbid:
                                        pendingTrack.albumMbid || undefined,
                                    artistMbid:
                                        pendingTrack.artistMbid || undefined,
                                },
                                {
                                    priority: 1, // High priority
                                    removeOnComplete: true,
                                },
                            );
                            logger.debug(
                                `[Retry] Queued library scan to reconcile pending tracks`,
                            );
                            sessionLog(
                                "PENDING-RETRY",
                                `Queued library scan (bullJobId=${
                                    scanJob.id ?? "unknown"
                                })`,
                            );
                        } catch (scanError) {
                            logger.error(
                                `[Retry] Failed to queue scan:`,
                                scanError,
                            );
                            sessionLog(
                                "PENDING-RETRY",
                                `Failed to queue scan: ${
                                    (scanError as any)?.message || scanError
                                }`,
                                "ERROR",
                            );
                        }
                    } else {
                        logger.debug(
                            `[Retry] Download failed: ${result.error}`,
                        );
                        sessionLog(
                            "PENDING-RETRY",
                            `Download failed: ${result.error || "unknown error"}`,
                            "WARN",
                        );

                        await prisma.downloadJob.update({
                            where: { id: downloadJob.id },
                            data: {
                                status: "failed",
                                error: result.error || "Download failed",
                                completedAt: new Date(),
                            },
                        });
                    }
                })
                .catch((error) => {
                    logger.error(`[Retry] Download error:`, error);
                    sessionLog(
                        "PENDING-RETRY",
                        `Download exception: ${error?.message || error}`,
                        "ERROR",
                    );

                    prisma.downloadJob
                        .update({
                            where: { id: downloadJob.id },
                            data: {
                                status: "failed",
                                error: error?.message || "Download exception",
                                completedAt: new Date(),
                            },
                        })
                        .catch(() => undefined);
                });
        } catch (error: any) {
            logger.error("Retry pending track error:", error);
            sessionLog(
                "PENDING-RETRY",
                `Handler error: ${error?.message || error}`,
                "ERROR",
            );
            res.status(500).json({
                error: "Failed to retry download",
                details: error.message,
            });
        }
    });

    /**
     * POST /playlists/:id/pending/reconcile
     * Manually trigger reconciliation for a specific playlist
     */
    router.post("/:id/pending/reconcile", async (req, res) => {
        try {
            const userId = req.user!.id;
            const playlistId = req.params.id;

            // Check ownership
            const playlist = await prisma.playlist.findUnique({
                where: { id: playlistId },
            });

            if (!playlist) {
                return res.status(404).json({ error: "Playlist not found" });
            }

            if (playlist.userId !== userId) {
                return res.status(403).json({ error: "Access denied" });
            }

            // Import and run reconciliation
            const { spotifyImportService } =
                await import("../../services/spotifyImport");
            const result = await spotifyImportService.reconcilePendingTracks();

            res.json({
                message: "Reconciliation complete",
                tracksAdded: result.tracksAdded,
                playlistsUpdated: result.playlistsUpdated,
            });
        } catch (error) {
            logger.error("Reconcile pending tracks error:", error);
            res.status(500).json({
                error: "Failed to reconcile pending tracks",
            });
        }
    });
}
