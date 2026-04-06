import { Router } from "express";
import path from "path";
import fs from "fs";
import { config } from "../../config";
import { prisma, Prisma } from "../../utils/db";
import {
    getJellyfinConfig,
    isJellyfinMusicSource,
    getJellyfinAlbums,
    getJellyfinAlbumByRgMbid,
    getJellyfinTracksAllForAlbum,
    getJellyfinItem,
    getJellyfinImageUrl,
    extractRgMbid,
} from "../../services/jellyfin";
import { getCachedOwnedAlbumIds } from "../../services/libraryListCache";
import {
    logger,
    ALBUM_SORT_MAP,
    MAX_LIMIT,
    MBID_REGEX,
    resolveIdForJellyfin,
    JELLYFIN_UNREACHABLE_MESSAGE,
} from "./_helpers";

const router = Router();

router.get("/albums", async (req, res) => {
    try {
        const {
            artistId,
            limit: limitParam = "500",
            offset: offsetParam = "0",
            filter = "owned", // owned (default), discovery, all
            sortBy = "name",
        } = req.query;
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 500,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        if (await isJellyfinMusicSource()) {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                logger.warn(
                    "[Library] Jellyfin albums: config null (missing URL, API key, or User ID?)"
                );
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
            try {
                const { albums, total } = await getJellyfinAlbums(cfg, {
                    limit,
                    offset,
                    artistId: (artistId as string) || undefined,
                });
                return res.json({
                    albums: albums.map((a) => ({
                        id: a.id,
                        title: a.title,
                        coverArt: a.coverArt,
                        coverUrl: a.coverArt,
                        artist: a.artist,
                        year: a.year,
                        rgMbid: a.rgMbid,
                    })),
                    total,
                    offset,
                    limit,
                });
                logger.info(
                    `[Library] Jellyfin albums: returned ${albums.length} of ${total}`
                );
            } catch (err: any) {
                logger.warn("[Library] Jellyfin albums error:", err?.message);
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
        }

        const orderBy = ALBUM_SORT_MAP[sortBy as string] ?? { title: "asc" as const };

        if (filter === "owned") {
            // When no artist filter, try precomputed cache first (worker refreshes every 5 min).
            if (!artistId) {
                const cachedIds = await getCachedOwnedAlbumIds(sortBy as string);
                if (cachedIds && cachedIds.length >= 0) {
                    const total = cachedIds.length;
                    const pageIds = cachedIds.slice(offset, offset + limit);
                    const albumsData = pageIds.length
                        ? await prisma.album.findMany({
                              where: { id: { in: pageIds } },
                              include: {
                                  artist: {
                                      select: {
                                          id: true,
                                          mbid: true,
                                          name: true,
                                      },
                                  },
                              },
                          })
                        : [];
                    const idOrder = new Map(pageIds.map((id, i) => [id, i]));
                    const sorted = (albumsData as typeof albumsData).sort(
                        (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0)
                    );
                    const albums = sorted.map((album) => ({
                        ...album,
                        coverArt: album.coverUrl,
                    }));
                    return res.json({ albums, total, offset, limit });
                }
            }

            // Cache miss or artistId filter: use raw SQL (no unbounded load into Node).
            const orderClause =
                sortBy === "name-desc"
                    ? Prisma.raw('a."title" DESC')
                    : sortBy === "recent"
                      ? Prisma.raw('a."year" DESC NULLS LAST')
                      : Prisma.raw('a."title" ASC');

            const idsResult = await prisma.$queryRaw<{ id: string }[]>`
                SELECT a.id
                FROM "Album" a
                WHERE EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
                AND (a.location = 'LIBRARY' OR a."rgMbid" IN (SELECT "rgMbid" FROM "OwnedAlbum"))
                ${artistId ? Prisma.sql`AND a."artistId" = ${artistId as string}` : Prisma.empty}
                ORDER BY ${orderClause}
                LIMIT ${limit}
                OFFSET ${offset}
            `;
            const ids = idsResult.map((r) => r.id);

            const [albumsData, totalResult] = await Promise.all([
                ids.length > 0
                    ? prisma.album.findMany({
                          where: { id: { in: ids } },
                          include: {
                              artist: {
                                  select: {
                                      id: true,
                                      mbid: true,
                                      name: true,
                                  },
                              },
                          },
                      })
                    : Promise.resolve([]),
                prisma.$queryRaw<[{ count: bigint }]>`
                    SELECT COUNT(*)::bigint as count
                    FROM "Album" a
                    WHERE EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
                    AND (a.location = 'LIBRARY' OR a."rgMbid" IN (SELECT "rgMbid" FROM "OwnedAlbum"))
                    ${artistId ? Prisma.sql`AND a."artistId" = ${artistId as string}` : Prisma.empty}
                `,
            ]);

            const total = Number(totalResult[0]?.count ?? 0);
            const idOrder = new Map(ids.map((id, i) => [id, i]));
            const sorted = (albumsData as typeof albumsData).sort(
                (a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0)
            );
            const albums = sorted.map((album) => ({
                ...album,
                coverArt: album.coverUrl,
            }));

            return res.json({ albums, total, offset, limit });
        }

        let where: any = {
            tracks: { some: {} }, // Only albums with tracks
        };
        if (filter === "discovery") {
            where.location = "DISCOVER";
        }
        if (artistId) {
            where.artistId = artistId as string;
        }

        const [albumsData, total] = await Promise.all([
            prisma.album.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy,
                include: {
                    artist: {
                        select: {
                            id: true,
                            mbid: true,
                            name: true,
                        },
                    },
                },
            }),
            prisma.album.count({ where }),
        ]);

        const albums = albumsData.map((album) => ({
            ...album,
            coverArt: album.coverUrl,
        }));

        res.json({
            albums,
            total,
            offset,
            limit,
        });
    } catch (error: any) {
        logger.error("[Library] Get albums error:", error?.message || error);
        logger.error("[Library] Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to fetch albums",
            details: error?.message,
        });
    }
});

// GET /library/albums/:id
router.get("/albums/:id", async (req, res) => {
    try {
        const idParam = decodeURIComponent(req.params.id);
        const resolvedId = resolveIdForJellyfin(idParam);

        // Jellyfin album (jellyfin:uuid or raw 32-char UUID from URL)
        if (resolvedId.startsWith("jellyfin:")) {
            if (!(await isJellyfinMusicSource())) {
                return res.status(404).json({ error: "Album not found" });
            }
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                return res.status(503).json({
                    error: "Jellyfin is not configured",
                    jellyfin: true,
                });
            }
            const rawId = resolvedId.slice("jellyfin:".length);
            const [albumItem, tracks] = await Promise.all([
                getJellyfinItem(cfg, rawId, "MusicAlbum"),
                getJellyfinTracksAllForAlbum(cfg, resolvedId),
            ]);
            if (!albumItem || albumItem.Type !== "MusicAlbum") {
                return res.status(404).json({ error: "Album not found" });
            }
            const artist = albumItem.AlbumArtists?.[0]
                ? {
                      id: `jellyfin:${albumItem.AlbumArtists[0].Id}`,
                      name: albumItem.AlbumArtists[0].Name,
                      mbid: null as string | null,
                  }
                : { id: "", name: "Unknown Artist", mbid: null as string | null };
            const coverArt = getJellyfinImageUrl(
                cfg.url,
                albumItem.Id,
                albumItem.ImageTags?.Primary,
                cfg.apiKey,
                cfg.userId
            );
            const rgMbid = extractRgMbid(albumItem.ProviderIds);
            return res.json({
                id: resolvedId,
                title: albumItem.Name,
                artist,
                tracks,
                owned: true,
                coverArt,
                coverUrl: coverArt,
                rgMbid: rgMbid ?? undefined,
            });
        }

        // Find album by ID or rgMbid (for discovery albums) in single query
        let album = await prisma.album.findFirst({
            where: {
                OR: [
                    { id: idParam },
                    { rgMbid: idParam },
                ],
            },
            include: {
                artist: {
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                    },
                },
                tracks: {
                    orderBy: { trackNo: Prisma.SortOrder.asc },
                },
            },
        });

        // If not in Prisma and Jellyfin mode: try album by MusicBrainz rgMbid when idParam is MBID format
        if (!album && MBID_REGEX.test(idParam) && (await isJellyfinMusicSource())) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                const albumItem = await getJellyfinAlbumByRgMbid(cfg, idParam);
                if (albumItem && albumItem.Type === "MusicAlbum") {
                    const resolvedId = `jellyfin:${albumItem.Id}`;
                    const tracks = await getJellyfinTracksAllForAlbum(cfg, resolvedId);
                    const artist = albumItem.AlbumArtists?.[0]
                        ? {
                              id: `jellyfin:${albumItem.AlbumArtists[0].Id}`,
                              name: albumItem.AlbumArtists[0].Name,
                              mbid: null as string | null,
                          }
                        : { id: "", name: "Unknown Artist", mbid: null as string | null };
                    const coverArt = getJellyfinImageUrl(
                        cfg.url,
                        albumItem.Id,
                        albumItem.ImageTags?.Primary,
                        cfg.apiKey,
                        cfg.userId
                    );
                    return res.json({
                        id: resolvedId,
                        title: albumItem.Name,
                        artist,
                        tracks,
                        owned: true,
                        coverArt,
                        coverUrl: coverArt,
                        rgMbid: idParam,
                    });
                }
            }
        }

        if (!album) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Check ownership with O(1) indexed lookup (separate query is faster than fetching all ownedAlbums)
        const owned = await prisma.ownedAlbum.findUnique({
            where: {
                artistId_rgMbid: {
                    artistId: album.artistId,
                    rgMbid: album.rgMbid,
                },
            },
        });
        let isOwned = !!owned;

        // Prisma album exists but OwnedAlbum says not owned — check Jellyfin.
        // The Prisma record may come from enrichment/discovery while the actual
        // music lives in Jellyfin. If found there, serve the Jellyfin version
        // which has playable tracks.
        if (!isOwned && album.rgMbid && (await isJellyfinMusicSource())) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                const jellyfinAlbum = await getJellyfinAlbumByRgMbid(cfg, album.rgMbid);
                if (jellyfinAlbum && jellyfinAlbum.Type === "MusicAlbum") {
                    const jfId = `jellyfin:${jellyfinAlbum.Id}`;
                    const tracks = await getJellyfinTracksAllForAlbum(cfg, jfId);
                    const artist = jellyfinAlbum.AlbumArtists?.[0]
                        ? {
                              id: `jellyfin:${jellyfinAlbum.AlbumArtists[0].Id}`,
                              name: jellyfinAlbum.AlbumArtists[0].Name,
                              mbid: album.artist?.mbid ?? null,
                          }
                        : album.artist
                          ? { id: album.artist.id, name: album.artist.name, mbid: album.artist.mbid ?? null }
                          : { id: "", name: "Unknown Artist", mbid: null as string | null };
                    const coverArt = getJellyfinImageUrl(
                        cfg.url,
                        jellyfinAlbum.Id,
                        jellyfinAlbum.ImageTags?.Primary,
                        cfg.apiKey,
                        cfg.userId
                    );
                    return res.json({
                        id: jfId,
                        title: jellyfinAlbum.Name || album.title,
                        artist,
                        tracks,
                        owned: true,
                        coverArt,
                        coverUrl: coverArt,
                        rgMbid: album.rgMbid,
                        year: album.year ?? jellyfinAlbum.ProductionYear ?? undefined,
                    });
                }
            }
        }

        const artistData = album.artist;

        res.json({
            ...album,
            artist: artistData,
            owned: isOwned,
            coverArt: album.coverUrl,
        });
    } catch (error) {
        logger.error("Get album error:", error);
        res.status(500).json({ error: "Failed to fetch album" });
    }
});

// DELETE /library/albums/:id
router.delete("/albums/:id", async (req, res) => {
    try {
        const album = await prisma.album.findUnique({
            where: { id: req.params.id },
            include: {
                artist: true,
                tracks: {
                    include: {
                        album: true,
                    },
                },
            },
        });

        if (!album) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Delete all track files
        let deletedFiles = 0;
        for (const track of album.tracks) {
            if (track.filePath) {
                try {
                    const absolutePath = path.join(
                        config.music.musicPath,
                        track.filePath
                    );

                    if (fs.existsSync(absolutePath)) {
                        fs.unlinkSync(absolutePath);
                        deletedFiles++;
                    }
                } catch (err) {
                    logger.warn("[DELETE] Could not delete file:", err);
                }
            }
        }

        // Try to delete album folder if empty
        try {
            const artistName = album.artist.name;
            const albumFolder = path.join(
                config.music.musicPath,
                artistName,
                album.title
            );

            if (fs.existsSync(albumFolder)) {
                const files = fs.readdirSync(albumFolder);
                if (files.length === 0) {
                    fs.rmdirSync(albumFolder);
                    logger.debug(
                        `[DELETE] Deleted empty album folder: ${albumFolder}`
                    );
                }
            }
        } catch (err) {
            logger.warn("[DELETE] Could not delete album folder:", err);
        }

        // Delete from database (cascade will delete tracks)
        await prisma.album.delete({
            where: { id: album.id },
        });

        logger.debug(
            `[DELETE] Deleted album: ${album.title} (${deletedFiles} files)`
        );

        res.json({
            message: "Album deleted successfully",
            deletedFiles,
        });
    } catch (error) {
        logger.error("Delete album error:", error);
        res.status(500).json({ error: "Failed to delete album" });
    }
});

export default router;
