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
} from "../../services/jellyfin";
import {
    albumWireShapeFromJellyfin,
    isCompilationAlbumFromArtists,
} from "./albumDetailHelpers";
import { getCachedOwnedAlbumIds } from "../../services/libraryListCache";
import { redisClient } from "../../utils/redis";
import {
    logger,
    ALBUM_SORT_MAP,
    MAX_LIMIT,
    MBID_REGEX,
    resolveIdForJellyfin,
    JELLYFIN_UNREACHABLE_MESSAGE,
} from "./_helpers";

const router = Router();

const ALBUM_LOOKUP_CIRCUIT_OPEN_KEY = "jf:circuit:album_lookup:open";
const ALBUM_LOOKUP_CIRCUIT_FAILS_KEY = "jf:circuit:album_lookup:fails";
const ALBUM_LOOKUP_CIRCUIT_FAIL_THRESHOLD = 3;
const ALBUM_LOOKUP_CIRCUIT_OPEN_SECONDS = 90;
const ALBUM_LOOKUP_CIRCUIT_FAIL_WINDOW_SECONDS = 5 * 60;
const ALBUM_LOOKUP_MISS_TTL_SECONDS = 10 * 60;

function albumLookupMissKey(id: string): string {
    return `jf:album_lookup:miss:${id}`;
}

async function isAlbumLookupCircuitOpen(): Promise<boolean> {
    if (!redisClient.isReady) return false;
    const open = await redisClient.get(ALBUM_LOOKUP_CIRCUIT_OPEN_KEY).catch(() => null);
    return open === "1";
}

async function recordAlbumLookupFailure(reason: string): Promise<void> {
    if (!redisClient.isReady) return;
    const failures = await redisClient
        .incr(ALBUM_LOOKUP_CIRCUIT_FAILS_KEY)
        .catch(() => null);
    if (!failures) return;
    if (failures === 1) {
        await redisClient
            .expire(ALBUM_LOOKUP_CIRCUIT_FAILS_KEY, ALBUM_LOOKUP_CIRCUIT_FAIL_WINDOW_SECONDS)
            .catch(() => {});
    }
    if (failures >= ALBUM_LOOKUP_CIRCUIT_FAIL_THRESHOLD) {
        await redisClient
            .setEx(ALBUM_LOOKUP_CIRCUIT_OPEN_KEY, ALBUM_LOOKUP_CIRCUIT_OPEN_SECONDS, "1")
            .catch(() => {});
        logger.warn(
            `[Album] Jellyfin lookup circuit opened after ${failures} failures (${reason})`
        );
    }
}

async function recordAlbumLookupSuccess(): Promise<void> {
    if (!redisClient.isReady) return;
    await redisClient.del(ALBUM_LOOKUP_CIRCUIT_OPEN_KEY).catch(() => {});
    await redisClient.del(ALBUM_LOOKUP_CIRCUIT_FAILS_KEY).catch(() => {});
}

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
                        albumArtists:
                            a.albumArtists && a.albumArtists.length > 0
                                ? a.albumArtists
                                : a.artist
                                  ? [a.artist]
                                  : [],
                        isCompilation: isCompilationAlbumFromArtists(
                            a.albumArtists && a.albumArtists.length > 0
                                ? a.albumArtists
                                : a.artist
                                  ? [a.artist]
                                  : []
                        ),
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

            // After Arch-X.d, all `Album` rows are owned/library content.
            // The "has tracks" predicate keeps cache identical to legacy
            // behavior — tracks-less rows shouldn't be served as owned.
            const idsResult = await prisma.$queryRaw<{ id: string }[]>`
                SELECT a.id
                FROM "Album" a
                WHERE EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
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
        // Post Arch-X.d, `Album.location = DISCOVER` rows no longer
        // exist (transient discovery lives on `SavedDiscoveryAlbum`).
        // The `?filter=discovery` query param is preserved for URL
        // backward-compat but always returns an empty list since no
        // Album row is discovery-only anymore.
        if (filter === "discovery") {
            return res.json({ albums: [], total: 0, offset, limit });
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
//
// Jellyfin-first resolution. Three branches:
//   1. `jellyfin:UUID` (or bare 32-char UUID) — direct Jellyfin fetch.
//      The common path; owned content always lands here after X.a.1.1.
//   2. MusicBrainz release-group MBID (dashed UUID) — typically a
//      discovery click. Look up in Jellyfin via the syncJellyfinOwnedAlbums
//      Redis cache, falling back to a bounded scan. If the user owns the
//      release, return owned response with playable Jellyfin tracks.
//      Otherwise 404 — the frontend then falls through to
//      `/artists/album/:rgMbid` for MusicBrainz-only data.
//   3. Anything else (legacy Prisma cuid) — defensive Prisma metadata
//      lookup returned as a discovery view (`owned: false`). Removed in
//      this PR: opportunistic Prisma <-> Jellyfin reconciliation
//      (AlbumSourceMap / AlbumOwnershipFact / AlbumArtistCredit /
//      TrackArtistCredit healing transactions, title/container search
//      fallbacks). Owned content reaches us as `jellyfin:UUID` now, so
//      the reconciliation has nothing to do.
router.get("/albums/:id", async (req, res) => {
    try {
        const idParam = decodeURIComponent(req.params.id);
        const resolvedId = resolveIdForJellyfin(idParam);

        // Branch 1: explicit Jellyfin id.
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
            if (
                !albumItem ||
                (albumItem.Type !== "MusicAlbum" &&
                    albumItem.Type !== "BoxSet")
            ) {
                return res.status(404).json({ error: "Album not found" });
            }
            return res.json(
                albumWireShapeFromJellyfin(cfg, albumItem, tracks)
            );
        }

        // Branch 2: MusicBrainz release-group MBID.
        if (MBID_REGEX.test(idParam)) {
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

            // Honor the existing miss-cache and circuit-breaker so we don't
            // pay for the bounded scan on every request when Jellyfin
            // demonstrably doesn't have this MBID (or is sick).
            const missKey = albumLookupMissKey(`mbid:${idParam}`);
            const hasMissCache = redisClient.isReady
                ? (await redisClient
                      .get(missKey)
                      .catch(() => null)) === "1"
                : false;
            const circuitOpen = await isAlbumLookupCircuitOpen();
            if (hasMissCache || circuitOpen) {
                logger.debug(
                    `[Album] Skipping MBID lookup for ${idParam} (${
                        hasMissCache ? "miss-cache" : "circuit-open"
                    })`
                );
                return res.status(404).json({ error: "Album not found" });
            }

            // Fast path: rgMbid → Jellyfin id is cached by
            // syncJellyfinOwnedAlbums. Use it for a cheap `Items/{id}`
            // lookup before falling back to the bounded scan.
            const cacheKey = `jf:rgmbid:${idParam}`;
            let albumItem: Awaited<
                ReturnType<typeof getJellyfinAlbumByRgMbid>
            > = null;
            const cachedJfId = redisClient.isReady
                ? await redisClient.get(cacheKey).catch(() => null)
                : null;
            if (cachedJfId) {
                albumItem = await getJellyfinItem(
                    cfg,
                    cachedJfId,
                    "MusicAlbum"
                ).catch(() => null);
            }
            if (!albumItem) {
                try {
                    albumItem = await getJellyfinAlbumByRgMbid(cfg, idParam);
                } catch (err) {
                    await recordAlbumLookupFailure("mbid-route");
                    if (redisClient.isReady) {
                        await redisClient
                            .setEx(
                                missKey,
                                ALBUM_LOOKUP_MISS_TTL_SECONDS,
                                "1"
                            )
                            .catch(() => {});
                    }
                    throw err;
                }
                if (albumItem && redisClient.isReady) {
                    await redisClient
                        .setEx(cacheKey, 30 * 24 * 3600, albumItem.Id)
                        .catch(() => {});
                }
            }

            if (
                !albumItem ||
                (albumItem.Type !== "MusicAlbum" &&
                    albumItem.Type !== "BoxSet")
            ) {
                if (redisClient.isReady) {
                    await redisClient
                        .setEx(
                            missKey,
                            ALBUM_LOOKUP_MISS_TTL_SECONDS,
                            "1"
                        )
                        .catch(() => {});
                }
                return res.status(404).json({ error: "Album not found" });
            }

            await recordAlbumLookupSuccess();
            if (redisClient.isReady) {
                await redisClient.del(missKey).catch(() => {});
            }

            const resolvedJfId = `jellyfin:${albumItem.Id}`;
            const tracks = await getJellyfinTracksAllForAlbum(
                cfg,
                resolvedJfId
            );
            return res.json(
                albumWireShapeFromJellyfin(cfg, albumItem, tracks, {
                    rgMbidFromUrl: idParam,
                })
            );
        }

        // Branch 3: legacy Prisma cuid path. Defensive read for any
        // bookmarked URLs still carrying raw Album.id values. We do NOT
        // reconcile against Jellyfin here. Post Arch-X.d the per-track
        // artist credit table (`TrackArtistCredit`) and album-level
        // credit table (`AlbumArtistCredit`) are gone — the legacy
        // path falls back to the Album.artist relation for both.
        const album = await prisma.album.findFirst({
            where: { id: idParam },
            include: {
                artist: {
                    select: { id: true, mbid: true, name: true },
                },
                tracks: {
                    orderBy: { trackNo: Prisma.SortOrder.asc },
                },
            },
        });
        if (!album) {
            return res.status(404).json({ error: "Album not found" });
        }

        const primaryArtist = album.artist
            ? {
                  id: album.artist.id,
                  name: album.artist.name,
                  mbid: album.artist.mbid ?? null,
              }
            : undefined;
        const albumArtists = primaryArtist ? [primaryArtist] : [];
        const tracks = album.tracks.map((track) => ({
            ...track,
            artist: primaryArtist,
        }));

        return res.json({
            ...album,
            artist: primaryArtist,
            albumArtists,
            tracks,
            owned: false,
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
        // Only the fields actually used below: album.artist.name (folder
        // cleanup), album.title (folder cleanup), and track.filePath (file
        // unlink). Previous shape included `tracks.album` which duplicated
        // the parent album row N times in the response payload.
        const album = await prisma.album.findUnique({
            where: { id: req.params.id },
            include: {
                artist: { select: { name: true } },
                tracks: { select: { filePath: true } },
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
