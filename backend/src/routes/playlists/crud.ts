import type { Router } from "express";
import { logger } from "../../utils/logger";
import { z } from "zod";
import { prisma } from "../../utils/db";
import {
    getJellyfinConfig,
    resolveTrackReferences,
    createJellyfinPlaylist,
    updateJellyfinPlaylistName,
    deleteJellyfinPlaylist,
    getJellyfinPlaylistItemsWithMetadata,
} from "../../services/jellyfin";
import { generatePlaylistCoverSvg } from "../../services/mixCoverService";
import { config } from "../../config";
import { syncJellyfinPlaylistToDb } from "./jellyfinSyncDb";
import { createPlaylistSchema, updatePlaylistSchema } from "./schemas";

export function registerPlaylistCrudRoutes(router: Router): void {
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
                const jellyfinPlaylistId = await createJellyfinPlaylist(
                    cfg,
                    data.name,
                    [],
                );
                if (jellyfinPlaylistId) {
                    await prisma.playlist.update({
                        where: { id: playlist.id },
                        data: { jellyfinPlaylistId },
                    });
                    (
                        playlist as { jellyfinPlaylistId?: string }
                    ).jellyfinPlaylistId = jellyfinPlaylistId;
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
                select: {
                    id: true,
                    name: true,
                    userId: true,
                    isPublic: true,
                    items: {
                        orderBy: { sort: "asc" },
                        take: 3,
                        select: { trackId: true },
                    },
                },
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

            const apiBaseUrl =
                process.env.API_URL || `http://localhost:${config.port}`;
            const size = parseInt(String(req.query.size || "400"), 10) || 400;
            const clampedSize = Math.min(600, Math.max(100, size));

            const dataUrl = await generatePlaylistCoverSvg(
                { id: playlist.id, name: playlist.name, coverUrls },
                clampedSize,
                apiBaseUrl,
            );

            const base64 = dataUrl.replace(/^data:image\/svg\+xml;base64,/, "");
            const svg = Buffer.from(base64, "base64").toString("utf-8");

            res.setHeader("Content-Type", "image/svg+xml");
            res.setHeader(
                "Cache-Control",
                "public, max-age=3600, s-maxage=3600",
            );
            res.send(svg);
        } catch (error) {
            logger.error("Get playlist cover error:", error);
            res.status(500).json({
                error: "Failed to generate playlist cover",
            });
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
                    album: {
                        id: string;
                        title: string;
                        coverUrl: string | null;
                        coverArt: string | null;
                        artist: { id: string; name: string };
                    };
                } | null;
            };
            let formattedItems: FormattedItem[];

            // Option A: For Jellyfin playlists, fetch directly from Jellyfin with full metadata (single API call)
            const cfg = await getJellyfinConfig();
            if (playlist.jellyfinPlaylistId && cfg) {
                const jellyfinItems =
                    await getJellyfinPlaylistItemsWithMetadata(
                        cfg,
                        playlist.jellyfinPlaylistId,
                    );
                formattedItems = jellyfinItems.map((jf, idx) => {
                    const trackId = `jellyfin:${jf.itemId}`;
                    const existingItem = playlist.items.find(
                        (i) => i.trackId === trackId,
                    );
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
                syncJellyfinPlaylistToDb(
                    playlist.id,
                    playlist.jellyfinPlaylistId,
                ).catch((err) =>
                    logger.warn(
                        "[Playlists] Background sync failed:",
                        err?.message,
                    ),
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
            const data = updatePlaylistSchema.parse(req.body);

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

            const nextName =
                typeof data.name === "string" ? data.name.trim() : undefined;
            const shouldSyncJellyfinName =
                !!existing.jellyfinPlaylistId &&
                !!nextName &&
                nextName !== existing.name;

            // Linked playlists are reconciled from Jellyfin on list fetch.
            // Require Jellyfin rename success first so local state doesn't "flip back".
            if (shouldSyncJellyfinName) {
                const cfg = await getJellyfinConfig();
                if (cfg) {
                    const synced = await updateJellyfinPlaylistName(
                        cfg,
                        existing.jellyfinPlaylistId!,
                        nextName,
                    );
                    if (!synced) {
                        return res.status(502).json({
                            error: "Failed to rename playlist in Jellyfin",
                        });
                    }
                }
            }

            const playlist = await prisma.playlist.update({
                where: { id: req.params.id },
                data: {
                    ...(nextName !== undefined ? { name: nextName } : {}),
                    ...(typeof data.isPublic === "boolean"
                        ? { isPublic: data.isPublic }
                        : {}),
                },
            });

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
                    deleteJellyfinPlaylist(
                        cfg,
                        existing.jellyfinPlaylistId,
                    ).catch((err) =>
                        logger.warn(
                            "[Playlists] Failed to delete Jellyfin playlist:",
                            err?.message,
                        ),
                    );
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
}
