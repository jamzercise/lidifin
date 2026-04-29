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
 * Lidarr-side cleanup operations: cleanup-lidarr, fix-tagging.
 */
export function registerCleanupRoutes(router: Router): void {
    router.post("/cleanup-lidarr", async (req, res) => {
        try {
            logger.debug(
                "\n[CLEANUP] Starting Lidarr cleanup of discovery-only artists..."
            );

            const settings = await getSystemSettings();

            if (
                !settings.lidarrEnabled ||
                !settings.lidarrUrl ||
                !settings.lidarrApiKey
            ) {
                return res.status(400).json({ error: "Lidarr not configured" });
            }

            // Get all artists from Lidarr
            const lidarrResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/artist`,
                {
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 30000,
                }
            );

            const lidarrArtists = lidarrResponse.data;
            logger.debug(
                `[CLEANUP] Found ${lidarrArtists.length} artists in Lidarr`
            );

            const artistsRemoved: string[] = [];
            const artistsKept: string[] = [];
            const errors: string[] = [];

            for (const lidarrArtist of lidarrArtists) {
                const artistMbid = lidarrArtist.foreignArtistId;
                const artistName = lidarrArtist.artistName;

                if (!artistMbid) continue;

                try {
                    // Check if this artist has any NATIVE library content (real user library)
                    // This is more reliable than checking Album.location which can be wrong
                    const hasNativeOwnedAlbums = await prisma.album.findFirst({
                        where: {
                            artist: { mbid: artistMbid },
                            tracks: { some: {} },
                        },
                        select: { id: true },
                    });

                    // Check if artist has any LIKED/MOVED discovery albums
                    const hasKeptDiscoveryAlbums =
                        await prisma.discoveryAlbum.findFirst({
                            where: {
                                artistMbid: artistMbid,
                                status: { in: ["LIKED", "MOVED"] },
                            },
                        });

                    // Check if artist has any ACTIVE discovery albums (current playlist)
                    const hasActiveDiscoveryAlbums =
                        await prisma.discoveryAlbum.findFirst({
                            where: {
                                artistMbid: artistMbid,
                                status: "ACTIVE",
                            },
                        });

                    if (hasNativeOwnedAlbums || hasKeptDiscoveryAlbums) {
                        // This artist should stay in Lidarr
                        artistsKept.push(
                            `${artistName} (has native library or kept albums)`
                        );
                        continue;
                    }

                    if (hasActiveDiscoveryAlbums) {
                        // This artist has a current discovery album, keep for now
                        artistsKept.push(`${artistName} (has active discovery)`);
                        continue;
                    }

                    // This artist has no library albums and no active/kept discovery albums
                    // They should be removed from Lidarr
                    logger.debug(
                        `[CLEANUP] Removing discovery-only artist: ${artistName}`
                    );

                    await axios.delete(
                        `${settings.lidarrUrl}/api/v1/artist/${lidarrArtist.id}`,
                        {
                            params: { deleteFiles: true },
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 30000,
                        }
                    );

                    artistsRemoved.push(artistName);
                    logger.debug(`[CLEANUP] Removed: ${artistName}`);
                } catch (error: any) {
                    const msg = `Failed to process ${artistName}: ${error.message}`;
                    errors.push(msg);
                    logger.error(`[CLEANUP] ${msg}`);
                }
            }

            logger.debug(`\n[CLEANUP] Complete:`);
            logger.debug(`   - Removed: ${artistsRemoved.length}`);
            logger.debug(`   - Kept: ${artistsKept.length}`);
            logger.debug(`   - Errors: ${errors.length}`);

            res.json({
                success: true,
                removed: artistsRemoved,
                kept: artistsKept,
                errors,
                summary: {
                    removed: artistsRemoved.length,
                    kept: artistsKept.length,
                    errors: errors.length,
                },
            });
        } catch (error: any) {
            logger.error(
                "[CLEANUP] Lidarr cleanup error:",
                error?.message || error
            );
            res.status(500).json({
                error: "Failed to cleanup Lidarr",
                details: error?.message || "Unknown error",
            });
        }
    });

    // POST /discover/fix-tagging — legacy repair for Album.location / OwnedAlbum (Arch-X.d removed both).
    router.post("/fix-tagging", async (_req, res) => {
        logger.debug(
            "\n[FIX-TAGGING] Skipped: Album.location and OwnedAlbum were removed in Arch-X.d."
        );
        res.json({
            success: true,
            albumsFixed: 0,
            ownedRecordsRemoved: 0,
            fixedArtists: [] as string[],
            message: "No longer applicable after schema slim (Album.location / OwnedAlbum removed).",
        });
    });
}
