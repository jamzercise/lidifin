import { Router } from "express";
import { logger } from "../utils/logger";
import { z } from "zod";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { sessionLog } from "../utils/playlistLogger";
import { config } from "../config";
import { generatePlaylistCoverSvg } from "../services/mixCoverService";
import {
    getJellyfinConfig,
    resolveTrackReference,
    resolveTrackReferences,
    createJellyfinPlaylist,
    addToJellyfinPlaylist,
    setJellyfinPlaylistItems,
    removeItemFromJellyfinPlaylistByItemId,
    getJellyfinPlaylists,
    getJellyfinPlaylistItems,
    getJellyfinPlaylistItemsWithMetadata,
    updateJellyfinPlaylistName,
    deleteJellyfinPlaylist,
} from "../services/jellyfin";

const router = Router();

router.use(requireAuthOrToken);

/**
 * Option D: Sync Jellyfin playlist items to DB in background.
 * Updates PlaylistItem records to match current Jellyfin state.
 * Fire-and-forget; call without awaiting.
 */
async function syncJellyfinPlaylistToDb(
    playlistId: string,
    jellyfinPlaylistId: string
): Promise<void> {
    const cfg = await getJellyfinConfig();
    if (!cfg) return;
    const items = await getJellyfinPlaylistItems(cfg, jellyfinPlaylistId);
    for (let i = 0; i < items.length; i++) {
        const trackId = `jellyfin:${items[i].itemId}`;
        await prisma.playlistItem.upsert({
            where: {
                playlistId_trackId: { playlistId, trackId },
            },
            create: { playlistId, trackId, sort: i },
            update: { sort: i },
        });
    }
    const currentTrackIds = new Set(items.map((it) => `jellyfin:${it.itemId}`));
    await prisma.playlistItem.deleteMany({
        where: {
            playlistId,
            trackId: { notIn: Array.from(currentTrackIds) },
        },
    });
}

const createPlaylistSchema = z.object({
    name: z.string().min(1).max(200),
    isPublic: z.boolean().optional().default(false),
});

const addTrackSchema = z.object({
    trackId: z.string(),
});

// GET /playlists
router.get("/", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;

        // Sync Jellyfin playlists into DB when Jellyfin is enabled
        const cfg = await getJellyfinConfig();
        if (cfg) {
            const jellyfinPlaylists = await getJellyfinPlaylists(cfg);
            const existingByJellyfinId = await prisma.playlist.findMany({
                where: {
                    jellyfinPlaylistId: { in: jellyfinPlaylists.map((p) => p.id) },
                },
                select: { jellyfinPlaylistId: true },
            });
            const existingJellyfinIds = new Set(
                existingByJellyfinId.map((p) => p.jellyfinPlaylistId).filter(Boolean) as string[]
            );

            for (const jp of jellyfinPlaylists) {
                if (existingJellyfinIds.has(jp.id)) continue;

                // Create Playlist record and sync items from Jellyfin
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
                            playlistId_trackId: { playlistId: playlist.id, trackId },
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
            hiddenPlaylists.map((h) => h.playlistId)
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
                items: {
                    select: { id: true, playlistId: true, trackId: true, sort: true },
                    orderBy: { sort: "asc" },
                },
            },
        });

        const playlistsWithCounts = playlists.map((playlist) => ({
            ...playlist,
            trackCount: playlist.items.length,
            isOwner: playlist.userId === userId,
            isHidden: hiddenPlaylistIds.has(playlist.id),
        }));

        // Debug: log shared playlists with user info
        const sharedPlaylists = playlistsWithCounts.filter((p) => !p.isOwner);
        if (sharedPlaylists.length > 0) {
            logger.debug(
                `[Playlists] Found ${sharedPlaylists.length} shared playlists for user ${userId}:`
            );
            sharedPlaylists.forEach((p) => {
                logger.debug(
                    `  - "${p.name}" by ${
                        p.user?.username || "UNKNOWN"
                    } (owner: ${p.userId})`
                );
            });
        }

        res.json(playlistsWithCounts);
    } catch (error) {
        logger.error("Get playlists error:", error);
        res.status(500).json({ error: "Failed to get playlists" });
    }
});

// POST /playlists
router.post("/", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const data = createPlaylistSchema.parse(req.body);

        const playlist = await prisma.playlist.create({
            data: {
                userId,
                name: data.name,
                isPublic: data.isPublic,
            },
        });

        // Lidifin: push to Jellyfin when enabled so playlist appears there too
        const cfg = await getJellyfinConfig();
        if (cfg) {
            const jellyfinPlaylistId = await createJellyfinPlaylist(cfg, data.name, []);
            if (jellyfinPlaylistId) {
                await prisma.playlist.update({
                    where: { id: playlist.id },
                    data: { jellyfinPlaylistId },
                });
                (playlist as { jellyfinPlaylistId?: string }).jellyfinPlaylistId =
                    jellyfinPlaylistId;
            }
        }

        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Create playlist error:", error);
        res.status(500).json({ error: "Failed to create playlist" });
    }
});

// GET /playlists/:id/cover - Generated cover for playlists without track covers (must be before /:id)
router.get("/:id/cover", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const playlistId = req.params.id;

        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
            select: { id: true, name: true, userId: true, isPublic: true, items: { orderBy: { sort: "asc" }, take: 3, select: { trackId: true } } },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        if (!playlist.isPublic && playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        let coverUrls: string[] = [];
        if (playlist.items.length > 0) {
            const trackIds = playlist.items.map((i) => i.trackId);
            const resolved = await resolveTrackReferences(trackIds);
            coverUrls = resolved
                .filter((t) => t?.album?.coverArt)
                .map((t) => t!.album!.coverArt!)
                .slice(0, 2);
        }

        const apiBaseUrl = process.env.API_URL || `http://localhost:${config.port}`;
        const size = parseInt(String(req.query.size || "400"), 10) || 400;
        const clampedSize = Math.min(600, Math.max(100, size));

        const dataUrl = await generatePlaylistCoverSvg(
            { id: playlist.id, name: playlist.name, coverUrls },
            clampedSize,
            apiBaseUrl
        );

        const base64 = dataUrl.replace(/^data:image\/svg\+xml;base64,/, "");
        const svg = Buffer.from(base64, "base64").toString("utf-8");

        res.setHeader("Content-Type", "image/svg+xml");
        res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
        res.send(svg);
    } catch (error) {
        logger.error("Get playlist cover error:", error);
        res.status(500).json({ error: "Failed to generate playlist cover" });
    }
});

// GET /playlists/:id
router.get("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;

        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
            include: {
                user: {
                    select: {
                        username: true,
                    },
                },
                hiddenByUsers: {
                    where: { userId },
                    select: { id: true },
                },
                items: {
                    orderBy: { sort: "asc" },
                },
                pendingTracks: {
                    orderBy: { sort: "asc" },
                },
            },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // Check access permissions
        if (!playlist.isPublic && playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        type FormattedItem = {
            id: string;
            playlistId: string;
            trackId: string;
            sort: number;
            type: "track";
            track: {
                id: string;
                title: string;
                duration: number;
                artist: { id: string; name: string };
                album: { id: string; title: string; coverUrl: string | null; coverArt: string | null; artist: { id: string; name: string } };
            } | null;
        };
        let formattedItems: FormattedItem[];

        // Option A: For Jellyfin playlists, fetch directly from Jellyfin with full metadata (single API call)
        const cfg = await getJellyfinConfig();
        if (playlist.jellyfinPlaylistId && cfg) {
            const jellyfinItems = await getJellyfinPlaylistItemsWithMetadata(
                cfg,
                playlist.jellyfinPlaylistId
            );
            formattedItems = jellyfinItems.map((jf, idx) => {
                const trackId = `jellyfin:${jf.itemId}`;
                const existingItem = playlist.items.find((i) => i.trackId === trackId);
                return {
                    id: existingItem?.id ?? `jellyfin-entry-${jf.entryId}`,
                    playlistId: playlist.id,
                    trackId,
                    sort: idx,
                    type: "track" as const,
                    track: {
                        id: jf.track.id,
                        title: jf.track.title,
                        duration: jf.track.duration,
                        artist: jf.track.artist,
                        album: {
                            id: jf.track.album.id,
                            title: jf.track.album.title,
                            coverUrl: jf.track.album.coverArt,
                            coverArt: jf.track.album.coverArt,
                            artist: jf.track.artist,
                        },
                    },
                };
            });
            // Option D: Background sync - update DB to match Jellyfin (fire-and-forget)
            syncJellyfinPlaylistToDb(playlist.id, playlist.jellyfinPlaylistId).catch((err) =>
                logger.warn("[Playlists] Background sync failed:", err?.message)
            );
        } else {
            // Non-Jellyfin or Jellyfin unavailable: use resolveTrackReferences
            const trackIds = playlist.items.map((i) => i.trackId);
            const resolved = await resolveTrackReferences(trackIds);
            formattedItems = playlist.items.map((item, idx) => {
                const track = resolved[idx];
                return {
                    ...item,
                    type: "track" as const,
                    track: track
                        ? {
                              id: track.id,
                              title: track.title,
                              duration: track.duration,
                              artist: track.artist,
                              album: {
                                  id: track.album.id,
                                  title: track.album.title,
                                  coverUrl: track.album.coverArt,
                                  coverArt: track.album.coverArt,
                                  artist: track.artist,
                              },
                          }
                        : null,
                };
            });
        }

        // Format pending tracks
        const formattedPending = playlist.pendingTracks.map((pending) => ({
            id: pending.id,
            type: "pending" as const,
            sort: pending.sort,
            pending: {
                id: pending.id,
                artist: pending.spotifyArtist,
                title: pending.spotifyTitle,
                album: pending.spotifyAlbum,
                previewUrl: pending.deezerPreviewUrl,
            },
        }));

        // Merge and sort by position
        const mergedItems = [
            ...formattedItems.map((item) => ({ ...item, sort: item.sort })),
            ...formattedPending,
        ].sort((a, b) => a.sort - b.sort);

        res.json({
            ...playlist,
            isOwner: playlist.userId === userId,
            isHidden: playlist.hiddenByUsers.length > 0,
            trackCount: formattedItems.length,
            pendingCount: playlist.pendingTracks.length,
            items: formattedItems,
            pendingTracks: formattedPending,
            mergedItems,
        });
    } catch (error) {
        logger.error("Get playlist error:", error);
        res.status(500).json({ error: "Failed to get playlist" });
    }
});

// PUT /playlists/:id
router.put("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const data = createPlaylistSchema.parse(req.body);

        // Check ownership
        const existing = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!existing) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (existing.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const playlist = await prisma.playlist.update({
            where: { id: req.params.id },
            data: {
                name: data.name,
                isPublic: data.isPublic,
            },
        });

        // Sync name to Jellyfin when applicable
        if (playlist.jellyfinPlaylistId && data.name) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                updateJellyfinPlaylistName(cfg, playlist.jellyfinPlaylistId, data.name).catch(
                    () => {}
                );
            }
        }

        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Update playlist error:", error);
        res.status(500).json({ error: "Failed to update playlist" });
    }
});

// POST /playlists/:id/hide - Hide any playlist from your view
router.post("/:id/hide", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const playlistId = req.params.id;

        // Check playlist exists
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // User must own the playlist OR it must be public (shared)
        if (playlist.userId !== userId && !playlist.isPublic) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Create hidden record (upsert to handle re-hiding)
        await prisma.hiddenPlaylist.upsert({
            where: {
                userId_playlistId: { userId, playlistId },
            },
            create: { userId, playlistId },
            update: {},
        });

        res.json({ message: "Playlist hidden", isHidden: true });
    } catch (error) {
        logger.error("Hide playlist error:", error);
        res.status(500).json({ error: "Failed to hide playlist" });
    }
});

// DELETE /playlists/:id/hide - Unhide a shared playlist
router.delete("/:id/hide", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const playlistId = req.params.id;

        // Delete hidden record if exists
        await prisma.hiddenPlaylist.deleteMany({
            where: { userId, playlistId },
        });

        res.json({ message: "Playlist unhidden", isHidden: false });
    } catch (error) {
        logger.error("Unhide playlist error:", error);
        res.status(500).json({ error: "Failed to unhide playlist" });
    }
});

// DELETE /playlists/:id
router.delete("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;

        // Check ownership
        const existing = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!existing) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (existing.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Delete from Jellyfin when applicable
        if (existing.jellyfinPlaylistId) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                deleteJellyfinPlaylist(cfg, existing.jellyfinPlaylistId).catch(() => {});
            }
        }

        await prisma.playlist.delete({
            where: { id: req.params.id },
        });

        res.json({ message: "Playlist deleted" });
    } catch (error) {
        logger.error("Delete playlist error:", error);
        res.status(500).json({ error: "Failed to delete playlist" });
    }
});

// POST /playlists/:id/items
router.post("/:id/items", async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        const userId = req.user.id;
        const parsedBody = addTrackSchema.safeParse(req.body);
        if (!parsedBody.success) {
            return res.status(400).json({
                error: "Invalid request",
                details: parsedBody.error.errors,
            });
        }
        const { trackId } = parsedBody.data;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
            include: {
                items: {
                    orderBy: { sort: "desc" },
                    take: 1,
                },
            },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Validate track exists (native: Prisma; jellyfin: resolve)
        if (!trackId.startsWith("jellyfin:")) {
            const track = await prisma.track.findUnique({
                where: { id: trackId },
            });
            if (!track) {
                return res.status(404).json({ error: "Track not found" });
            }
        } else {
            const resolved = await resolveTrackReference(trackId);
            if (!resolved) {
                return res.status(404).json({ error: "Track not found" });
            }
        }

        // Check if track already in playlist
        const existing = await prisma.playlistItem.findUnique({
            where: {
                playlistId_trackId: {
                    playlistId: req.params.id,
                    trackId,
                },
            },
        });

        if (existing) {
            return res.status(200).json({
                message: "Track already in playlist",
                duplicated: true,
                item: existing,
            });
        }

        // Get next sort position
        const maxSort = playlist.items[0]?.sort || 0;

        const item = await prisma.playlistItem.create({
            data: {
                playlistId: req.params.id,
                trackId,
                sort: maxSort + 1,
            },
        });

        // Lidifin: push new item to Jellyfin playlist when applicable
        if (trackId.startsWith("jellyfin:")) {
            const playlist = await prisma.playlist.findUnique({
                where: { id: req.params.id },
                select: { jellyfinPlaylistId: true },
            });
            if (playlist?.jellyfinPlaylistId) {
                const cfg = await getJellyfinConfig();
                if (cfg) {
                    addToJellyfinPlaylist(
                        cfg,
                        playlist.jellyfinPlaylistId,
                        [trackId.slice("jellyfin:".length)]
                    ).catch(() => {});
                }
            }
        }

        const resolvedTrack = await resolveTrackReference(trackId);
        res.json({
            ...item,
            track: resolvedTrack
                ? {
                      id: resolvedTrack.id,
                      title: resolvedTrack.title,
                      duration: resolvedTrack.duration,
                      artist: resolvedTrack.artist,
                      album: {
                          ...resolvedTrack.album,
                          coverUrl: resolvedTrack.album.coverArt,
                          artist: resolvedTrack.artist,
                      },
                  }
                : null,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Add track to playlist error:", error);
        res.status(500).json({ error: "Failed to add track to playlist" });
    }
});

// DELETE /playlists/:id/items/:trackId
router.delete("/:id/items/:trackId", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const trackId = req.params.trackId;
        if (trackId.startsWith("jellyfin:") && playlist.jellyfinPlaylistId) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                removeItemFromJellyfinPlaylistByItemId(
                    cfg,
                    playlist.jellyfinPlaylistId,
                    trackId.slice("jellyfin:".length)
                ).catch(() => {});
            }
        }

        await prisma.playlistItem.delete({
            where: {
                playlistId_trackId: {
                    playlistId: req.params.id,
                    trackId,
                },
            },
        });

        res.json({ message: "Track removed from playlist" });
    } catch (error) {
        logger.error("Remove track from playlist error:", error);
        res.status(500).json({ error: "Failed to remove track from playlist" });
    }
});

// PUT /playlists/:id/items/reorder
router.put("/:id/items/reorder", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { trackIds } = req.body; // Array of track IDs in new order

        if (!Array.isArray(trackIds)) {
            return res.status(400).json({ error: "trackIds must be an array" });
        }

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Update sort order for each track
        const updates = trackIds.map((trackId, index) =>
            prisma.playlistItem.update({
                where: {
                    playlistId_trackId: {
                        playlistId: req.params.id,
                        trackId,
                    },
                },
                data: { sort: index },
            })
        );

        await prisma.$transaction(updates);

        // Lidifin: sync new order to Jellyfin (only Jellyfin-track ids)
        const playlistMeta = await prisma.playlist.findUnique({
            where: { id: req.params.id },
            select: { jellyfinPlaylistId: true },
        });
        if (playlistMeta?.jellyfinPlaylistId) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                const jellyfinIds = trackIds
                    .filter((id) => id.startsWith("jellyfin:"))
                    .map((id) => id.slice("jellyfin:".length));
                setJellyfinPlaylistItems(cfg, playlistMeta.jellyfinPlaylistId, jellyfinIds).catch(
                    () => {}
                );
            }
        }

        res.json({ message: "Playlist reordered" });
    } catch (error) {
        logger.error("Reorder playlist error:", error);
        res.status(500).json({ error: "Failed to reorder playlist" });
    }
});

/**
 * GET /playlists/:id/pending
 * Get pending tracks for a playlist (tracks from Spotify that haven't been matched yet)
 */
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
            return res.status(404).json({ error: "Pending track not found" });
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
            return res.status(404).json({ error: "Pending track not found" });
        }

        // Fetch fresh Deezer preview URL
        const { deezerService } = await import("../services/deezer");
        const previewUrl = await deezerService.getTrackPreview(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle
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
            `Request: userId=${userId} playlistId=${playlistId} pendingTrackId=${pendingTrackId}`
        );

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            sessionLog(
                "PENDING-RETRY",
                `Playlist not found: ${playlistId}`,
                "WARN"
            );
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            sessionLog(
                "PENDING-RETRY",
                `Access denied: playlistId=${playlistId} userId=${userId}`,
                "WARN"
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
                "WARN"
            );
            return res.status(404).json({ error: "Pending track not found" });
        }

        sessionLog(
            "PENDING-RETRY",
            `Pending track: artist="${pendingTrack.spotifyArtist}" title="${pendingTrack.spotifyTitle}" album="${pendingTrack.spotifyAlbum}"`
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
            `Created download job: downloadJobId=${downloadJob.id} target=${retryTargetId}`
        );

        // Import soulseek service and try to download
        const { soulseekService } = await import("../services/soulseek");
        const { getSystemSettings } = await import("../utils/systemSettings");

        const settings = await getSystemSettings();
        if (!settings?.musicPath) {
            sessionLog("PENDING-RETRY", `Music path not configured`, "WARN");
            await prisma.downloadJob.update({
                where: { id: downloadJob.id },
                data: {
                    status: "failed",
                    error: "Music path not configured",
                    completedAt: new Date(),
                },
            });
            return res.status(400).json({ error: "Music path not configured" });
        }

        if (!settings?.soulseekUsername || !settings?.soulseekPassword) {
            sessionLog(
                "PENDING-RETRY",
                `Soulseek credentials not configured`,
                "WARN"
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
            `[Retry] Starting download for: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`
        );
        sessionLog(
            "PENDING-RETRY",
            `Search: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`
        );

        // First do a quick search to see if track is available (15s timeout)
        // This way we can tell the user immediately if it's not found
        const searchResult = await soulseekService.searchTrack(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle
        );

        if (!searchResult.found || searchResult.allMatches.length === 0) {
            logger.debug(`[Retry] No results found on Soulseek`);
            sessionLog("PENDING-RETRY", `No results found on Soulseek`, "INFO");

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
            `[Retry] ✓ Found ${searchResult.allMatches.length} results, starting download in background`
        );
        sessionLog(
            "PENDING-RETRY",
            `Found ${searchResult.allMatches.length} candidate(s); starting background download`
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
                settings.musicPath
            )
            .then(async (result) => {
                if (result.success) {
                    logger.debug(
                        `[Retry] ✓ Download complete: ${result.filePath}`
                    );
                    sessionLog(
                        "PENDING-RETRY",
                        `Download complete: filePath=${result.filePath}`
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
                        const { scanQueue } = await import("../workers/queues");
                        const scanJob = await scanQueue.add(
                            "scan",
                            {
                                userId,
                                source: "retry-pending-track",
                                albumMbid: pendingTrack.albumMbid || undefined,
                                artistMbid:
                                    pendingTrack.artistMbid || undefined,
                            },
                            {
                                priority: 1, // High priority
                                removeOnComplete: true,
                            }
                        );
                        logger.debug(
                            `[Retry] Queued library scan to reconcile pending tracks`
                        );
                        sessionLog(
                            "PENDING-RETRY",
                            `Queued library scan (bullJobId=${
                                scanJob.id ?? "unknown"
                            })`
                        );
                    } catch (scanError) {
                        logger.error(
                            `[Retry] Failed to queue scan:`,
                            scanError
                        );
                        sessionLog(
                            "PENDING-RETRY",
                            `Failed to queue scan: ${
                                (scanError as any)?.message || scanError
                            }`,
                            "ERROR"
                        );
                    }
                } else {
                    logger.debug(`[Retry] Download failed: ${result.error}`);
                    sessionLog(
                        "PENDING-RETRY",
                        `Download failed: ${result.error || "unknown error"}`,
                        "WARN"
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
                    "ERROR"
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
            "ERROR"
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
        const { spotifyImportService } = await import(
            "../services/spotifyImport"
        );
        const result = await spotifyImportService.reconcilePendingTracks();

        res.json({
            message: "Reconciliation complete",
            tracksAdded: result.tracksAdded,
            playlistsUpdated: result.playlistsUpdated,
        });
    } catch (error) {
        logger.error("Reconcile pending tracks error:", error);
        res.status(500).json({ error: "Failed to reconcile pending tracks" });
    }
});

export default router;
