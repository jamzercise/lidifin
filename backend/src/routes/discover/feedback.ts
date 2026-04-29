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
 * User feedback on discovery picks: like (move to library), unlike (revert).
 */
export function registerFeedbackRoutes(router: Router): void {
    // POST /discover/like - Like a track (marks entire album for keeping)
    router.post("/like", async (req, res) => {
        try {
            const userId = req.user!.id;
            const { albumId } = req.body;

            if (!albumId) {
                return res.status(400).json({ error: "albumId required" });
            }

            // Find the discovery album
            const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
                where: {
                    userId,
                    rgMbid: albumId,
                    status: "ACTIVE",
                },
            });

            if (!discoveryAlbum) {
                return res
                    .status(404)
                    .json({ error: "Album not in active discovery" });
            }

            // Mark as liked (entire album will be kept)
            await prisma.discoveryAlbum.update({
                where: { id: discoveryAlbum.id },
                data: {
                    status: "LIKED",
                    likedAt: new Date(),
                },
            });

            // Remove discovery tag from the artist in Lidarr
            // This prevents the artist from being deleted during cleanup
            logger.debug(
                `   Removing discovery tag from artist: ${discoveryAlbum.artistName}`
            );

            // If artistMbid is a temp ID, we need to search Lidarr by artist name instead
            if (
                discoveryAlbum.artistMbid &&
                !discoveryAlbum.artistMbid.startsWith("temp-")
            ) {
                await lidarrService.removeDiscoveryTagByMbid(
                    discoveryAlbum.artistMbid
                );
            } else {
                // Search Lidarr for the artist by name and remove tag
                try {
                    const lidarrArtists = await lidarrService.getArtists();
                    const lidarrArtist = lidarrArtists.find(
                        (a) =>
                            a.artistName.toLowerCase() ===
                            discoveryAlbum.artistName.toLowerCase()
                    );

                    if (lidarrArtist) {
                        const tagId = await lidarrService.getOrCreateDiscoveryTag();
                        if (tagId && lidarrArtist.tags?.includes(tagId)) {
                            await lidarrService.removeTagsFromArtist(
                                lidarrArtist.id,
                                [tagId]
                            );
                            logger.debug(
                                `   Removed discovery tag from ${lidarrArtist.artistName} (found by name)`
                            );
                        }
                    } else {
                        logger.debug(
                            `   Artist ${discoveryAlbum.artistName} not found in Lidarr (may have been removed)`
                        );
                    }
                } catch (e: any) {
                    logger.debug(`   Failed to remove discovery tag: ${e.message}`);
                }
            }

            // Match scanned Album by rgMbid or artist + title (ids can differ from DiscoveryAlbum).
            const dbAlbum = await prisma.album.findFirst({
                where: {
                    OR: [
                        { rgMbid: albumId },
                        {
                            title: {
                                equals: discoveryAlbum.albumTitle,
                                mode: "insensitive",
                            },
                            artist: {
                                name: {
                                    equals: discoveryAlbum.artistName,
                                    mode: "insensitive",
                                },
                            },
                        },
                    ],
                },
                include: { artist: true },
            });

            if (dbAlbum) {
                // Arch-X.d removed Album.location and OwnedAlbum;
                // ownership is read from Jellyfin at request time.
                // The album row simply remains in the DB; flipping the
                // DiscoveryAlbum status is handled below (or was
                // already handled by `discoveryAlbumLifecycle`).
                logger.debug(
                    ` Liked album: ${dbAlbum.artist.name} - ${dbAlbum.title} (matched from discovery)`
                );
            } else {
                logger.debug(
                    `   [WARN] Could not find scanned album for: ${discoveryAlbum.artistName} - ${discoveryAlbum.albumTitle}`
                );
            }

            // Retroactively mark all plays from this album as DISCOVERY_KEPT
            // Note: This requires getting tracks from the album first
            const tracks = await prisma.discoveryTrack.findMany({
                where: { discoveryAlbumId: discoveryAlbum.id },
                select: { trackId: true },
            });

            const trackIds = tracks
                .map((t) => t.trackId)
                .filter((id): id is string => id !== null);

            if (trackIds.length > 0) {
                await prisma.play.updateMany({
                    where: {
                        userId,
                        trackId: { in: trackIds },
                        source: "DISCOVERY",
                    },
                    data: {
                        source: "DISCOVERY_KEPT",
                    },
                });
            }

            res.json({ success: true });
        } catch (error) {
            logger.error("Like discovery album error:", error);
            res.status(500).json({ error: "Failed to like album" });
        }
    });

    // DELETE /discover/unlike - Unlike a track
    router.delete("/unlike", async (req, res) => {
        try {
            const userId = req.user!.id;
            const { albumId } = req.body;

            if (!albumId) {
                return res.status(400).json({ error: "albumId required" });
            }

            const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
                where: {
                    userId,
                    rgMbid: albumId,
                    status: "LIKED",
                },
            });

            if (!discoveryAlbum) {
                return res.status(404).json({ error: "Album not liked" });
            }

            // Revert status back to ACTIVE
            await prisma.discoveryAlbum.update({
                where: { id: discoveryAlbum.id },
                data: {
                    status: "ACTIVE",
                    likedAt: null,
                },
            });

            // Arch-X.d removed OwnedAlbum; ownership lives in Jellyfin.

            // Revert plays back to DISCOVERY source
            const tracks = await prisma.discoveryTrack.findMany({
                where: { discoveryAlbumId: discoveryAlbum.id },
                select: { trackId: true },
            });

            const trackIds = tracks
                .map((t) => t.trackId)
                .filter((id): id is string => id !== null);

            if (trackIds.length > 0) {
                await prisma.play.updateMany({
                    where: {
                        userId,
                        trackId: { in: trackIds },
                        source: "DISCOVERY_KEPT",
                    },
                    data: {
                        source: "DISCOVERY",
                    },
                });
            }

            res.json({ success: true });
        } catch (error) {
            logger.error("Unlike discovery album error:", error);
            res.status(500).json({ error: "Failed to unlike album" });
        }
    });
}
