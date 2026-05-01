import type { Router } from "express";
import { logger } from "../../utils/logger";
import { prisma } from "../../utils/db";
import { config } from "../../config";
import {
    getJellyfinConfig,
    resolveTrackReferences,
    getJellyfinPlaylists,
    getJellyfinPlaylistItems,
} from "../../services/jellyfin";
import { syncJellyfinPlaylistToDb } from "./jellyfinSyncDb";

export function registerPlaylistListRoute(router: Router): void {
    router.get("/", async (req, res) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: "Unauthorized" });
            }
            const userId = req.user.id;

            // Full reconciliation: sync Jellyfin playlists into DB when Jellyfin is enabled.
            // This handles new playlists, deleted playlists, renamed playlists, and stale item counts.
            const cfg = await getJellyfinConfig();
            if (cfg) {
                const jellyfinPlaylists = await getJellyfinPlaylists(cfg);
                const jellyfinIdToPlaylist = new Map(
                    jellyfinPlaylists.map((p) => [p.id, p]),
                );
                const jellyfinIds = new Set(jellyfinPlaylists.map((p) => p.id));

                // Find all existing DB playlists linked to Jellyfin
                const existingDbPlaylists = await prisma.playlist.findMany({
                    where: { jellyfinPlaylistId: { not: null } },
                    select: { id: true, name: true, jellyfinPlaylistId: true },
                });

                const existingJellyfinIds = new Set<string>();

                for (const dbPl of existingDbPlaylists) {
                    const jfId = dbPl.jellyfinPlaylistId!;

                    if (!jellyfinIds.has(jfId)) {
                        // Playlist was deleted in Jellyfin — remove from Lidifin DB
                        logger.debug(
                            `[Playlists] Removing orphan playlist "${dbPl.name}" (Jellyfin ID ${jfId} no longer exists)`,
                        );
                        await prisma.playlistItem.deleteMany({
                            where: { playlistId: dbPl.id },
                        });
                        await prisma.hiddenPlaylist.deleteMany({
                            where: { playlistId: dbPl.id },
                        });
                        await prisma.playlist.delete({
                            where: { id: dbPl.id },
                        });
                        continue;
                    }

                    existingJellyfinIds.add(jfId);

                    // Update name if it changed in Jellyfin
                    const jfPlaylist = jellyfinIdToPlaylist.get(jfId);
                    if (jfPlaylist && jfPlaylist.name !== dbPl.name) {
                        logger.debug(
                            `[Playlists] Updating name for playlist "${dbPl.name}" → "${jfPlaylist.name}"`,
                        );
                        await prisma.playlist.update({
                            where: { id: dbPl.id },
                            data: { name: jfPlaylist.name },
                        });
                    }

                    // Refresh item count from Jellyfin in background (fire-and-forget)
                    syncJellyfinPlaylistToDb(dbPl.id, jfId).catch((err: unknown) =>
                        logger.warn(
                            `[Playlists] Background item sync failed for ${jfId}:`,
                            err instanceof Error ? err.message : err,
                        ),
                    );
                }

                // Import any new Jellyfin playlists not yet in DB
                for (const jp of jellyfinPlaylists) {
                    if (existingJellyfinIds.has(jp.id)) continue;

                    const playlist = await prisma.playlist.create({
                        data: {
                            userId,
                            name: jp.name,
                            jellyfinPlaylistId: jp.id,
                        },
                    });

                    const items = await getJellyfinPlaylistItems(cfg, jp.id);
                    for (let i = 0; i < items.length; i++) {
                        const trackId = `jellyfin:${items[i].itemId}`;
                        await prisma.playlistItem.upsert({
                            where: {
                                playlistId_trackId: {
                                    playlistId: playlist.id,
                                    trackId,
                                },
                            },
                            create: {
                                playlistId: playlist.id,
                                trackId,
                                sort: i,
                            },
                            update: { sort: i },
                        });
                    }
                }
            }

            // Get user's hidden playlists
            const hiddenPlaylists = await prisma.hiddenPlaylist.findMany({
                where: { userId },
                select: { playlistId: true },
            });
            const hiddenPlaylistIds = new Set(
                hiddenPlaylists.map((h) => h.playlistId),
            );

            const playlists = await prisma.playlist.findMany({
                where: {
                    OR: [{ userId }, { isPublic: true }],
                },
                orderBy: { createdAt: "desc" },
                include: {
                    user: {
                        select: {
                            username: true,
                        },
                    },
                    _count: {
                        select: { items: true },
                    },
                },
            });

            const playlistsWithCounts = playlists.map((playlist) => {
                const { _count, ...rest } = playlist;
                return {
                    ...rest,
                    items: [],
                    trackCount: _count.items,
                    isOwner: playlist.userId === userId,
                    isHidden: hiddenPlaylistIds.has(playlist.id),
                };
            });

            // Debug: log shared playlists with user info
            const sharedPlaylists = playlistsWithCounts.filter(
                (p) => !p.isOwner,
            );
            if (sharedPlaylists.length > 0) {
                logger.debug(
                    `[Playlists] Found ${sharedPlaylists.length} shared playlists for user ${userId}:`,
                );
                sharedPlaylists.forEach((p) => {
                    logger.debug(
                        `  - "${p.name}" by ${
                            p.user?.username || "UNKNOWN"
                        } (owner: ${p.userId})`,
                    );
                });
            }

            res.json(playlistsWithCounts);
        } catch (error) {
            logger.error("Get playlists error:", error);
            res.status(500).json({ error: "Failed to get playlists" });
        }
    });
}
