import type { Router } from "express";
import { logger } from "../../utils/logger";
import { z } from "zod";
import { prisma } from "../../utils/db";
import {
    getJellyfinConfig,
    resolveTrackReference,
    addToJellyfinPlaylist,
    setJellyfinPlaylistItems,
    removeItemFromJellyfinPlaylistByItemId,
} from "../../services/jellyfin";
import { addTrackSchema } from "./schemas";

export function registerPlaylistItemRoutes(router: Router): void {
    router.post("/:id/items", async (req, res) => {
        try {
            if (!req.user)
                return res.status(401).json({ error: "Unauthorized" });
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
                            [trackId.slice("jellyfin:".length)],
                        ).catch((err) =>
                            logger.warn(
                                "[Playlists] Failed to add track to Jellyfin playlist:",
                                err?.message,
                            ),
                        );
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
            if (
                trackId.startsWith("jellyfin:") &&
                playlist.jellyfinPlaylistId
            ) {
                const cfg = await getJellyfinConfig();
                if (cfg) {
                    removeItemFromJellyfinPlaylistByItemId(
                        cfg,
                        playlist.jellyfinPlaylistId,
                        trackId.slice("jellyfin:".length),
                    ).catch((err) =>
                        logger.warn(
                            "[Playlists] Failed to remove track from Jellyfin playlist:",
                            err?.message,
                        ),
                    );
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
            res.status(500).json({
                error: "Failed to remove track from playlist",
            });
        }
    });

    // PUT /playlists/:id/items/reorder
    router.put("/:id/items/reorder", async (req, res) => {
        try {
            const userId = req.user!.id;
            const { trackIds } = req.body; // Array of track IDs in new order

            if (!Array.isArray(trackIds)) {
                return res
                    .status(400)
                    .json({ error: "trackIds must be an array" });
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
                }),
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
                    setJellyfinPlaylistItems(
                        cfg,
                        playlistMeta.jellyfinPlaylistId,
                        jellyfinIds,
                    ).catch((err) =>
                        logger.warn(
                            "[Playlists] Failed to sync reorder to Jellyfin:",
                            err?.message,
                        ),
                    );
                }
            }

            res.json({ message: "Playlist reordered" });
        } catch (error) {
            logger.error("Reorder playlist error:", error);
            res.status(500).json({ error: "Failed to reorder playlist" });
        }
    });
}
