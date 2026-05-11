import type { Router } from "express";
import {
    saveDiscoveryAlbum,
    listSavedDiscoveryAlbums,
    unsaveDiscoveryAlbum,
    countSavedDiscoveryAlbums,
} from "../../services/savedDiscoveryAlbumService";
import { logger } from "../../utils/logger";

/**
 * Arch-X.c: user-owned bookmarks for MusicBrainz release groups (discovery),
 * separate from Jellyfin library content.
 *
 * GET    /discover/saved-albums
 * POST   /discover/saved-albums
 * DELETE /discover/saved-albums/:rgMbid
 */
export function registerSavedAlbumsRoutes(router: Router): void {
    router.get("/saved-albums", async (req, res) => {
        try {
            const userId = req.user!.id;
            const limitRaw = parseInt(String(req.query.limit ?? "100"), 10);
            const offsetRaw = parseInt(String(req.query.offset ?? "0"), 10);
            const limit = Number.isFinite(limitRaw)
                ? Math.min(500, Math.max(1, limitRaw))
                : 100;
            const offset = Number.isFinite(offsetRaw)
                ? Math.max(0, offsetRaw)
                : 0;

            const [total, albums] = await Promise.all([
                countSavedDiscoveryAlbums(userId),
                listSavedDiscoveryAlbums(userId, { skip: offset, take: limit }),
            ]);

            res.json({
                albums,
                total,
                offset,
                limit,
            });
        } catch (error: unknown) {
            logger.error("[Discover] List saved albums error:", error);
            res.status(500).json({
                error: "Failed to list saved albums",
            });
        }
    });

    router.post("/saved-albums", async (req, res) => {
        try {
            const userId = req.user!.id;
            const body = req.body ?? {};
            const rgMbid = body.rgMbid;
            const artistName = body.artistName;
            const albumTitle = body.albumTitle;

            if (
                typeof rgMbid !== "string" ||
                typeof artistName !== "string" ||
                typeof albumTitle !== "string"
            ) {
                return res.status(400).json({
                    error: "rgMbid, artistName, and albumTitle are required",
                });
            }

            const album = await saveDiscoveryAlbum({
                userId,
                rgMbid: rgMbid.trim(),
                artistName: artistName.trim(),
                albumTitle: albumTitle.trim(),
                artistMbid:
                    typeof body.artistMbid === "string"
                        ? body.artistMbid.trim() || null
                        : body.artistMbid ?? null,
                coverUrl:
                    typeof body.coverUrl === "string"
                        ? body.coverUrl.trim() || null
                        : body.coverUrl ?? null,
                source:
                    typeof body.source === "string"
                        ? body.source.trim() || null
                        : body.source ?? null,
            });

            res.status(201).json({ album });
        } catch (error: unknown) {
            const msg =
                error instanceof Error ? error.message : String(error);
            if (msg.includes("[SavedDiscoveryAlbum]")) {
                return res.status(400).json({ error: msg });
            }
            logger.error("[Discover] Save album error:", error);
            res.status(500).json({
                error: "Failed to save album",
            });
        }
    });

    router.delete("/saved-albums/:rgMbid", async (req, res) => {
        try {
            const userId = req.user!.id;
            const rgMbid = decodeURIComponent(req.params.rgMbid);
            const removed = await unsaveDiscoveryAlbum(userId, rgMbid);
            res.json({ removed });
        } catch (error: unknown) {
            const msg =
                error instanceof Error ? error.message : String(error);
            if (msg.includes("[SavedDiscoveryAlbum]")) {
                return res.status(400).json({ error: msg });
            }
            logger.error("[Discover] Unsave album error:", error);
            res.status(500).json({
                error: "Failed to remove saved album",
            });
        }
    });
}
