import { Router } from "express";
import path from "path";
import fs from "fs";
import { config } from "../../config";
import { prisma, Prisma } from "../../utils/db";
import {
    getJellyfinConfig,
    isJellyfinMusicSource,
    getJellyfinAlbums,
    getJellyfinAlbumContainers,
    getJellyfinAlbumByRgMbid,
    getJellyfinTracksAllForAlbum,
    getJellyfinItem,
    getJellyfinImageUrl,
    extractRgMbid,
} from "../../services/jellyfin";
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

function normalizeTitle(value: string | null | undefined): string {
    return (value ?? "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isVariousArtistsName(value: string): boolean {
    return (
        value === "various artists" ||
        value === "various artist" ||
        value === "various" ||
        value === "va"
    );
}

function getAlbumArtistsFromJellyfinItem(item: any): Array<{ id: string; name: string }> {
    return (item?.AlbumArtists ?? [])
        .filter((a: any) => !!a?.Id && !!a?.Name)
        .map((a: any) => ({
            id: `jellyfin:${a.Id}`,
            name: a.Name,
        }));
}

function isCompilationAlbumFromArtists(
    albumArtists: Array<{ id: string; name: string }>
): boolean {
    const normalized = albumArtists
        .map((a) => normalizeTitle(a.name))
        .filter(Boolean);
    if (normalized.some((n) => isVariousArtistsName(n))) return true;
    return new Set(normalized).size > 1;
}

function tokenSet(value: string): Set<string> {
    return new Set(
        value
            .split(" ")
            .map((t) => t.trim())
            .filter((t) => t.length >= 3)
    );
}

function normalizeTitleLoose(value: string | null | undefined): string {
    return normalizeTitle(value)
        .replace(
            /\b(?:box\s*set|disc|disk|cd|volume|vol|part|pt)\s*(?:\d+|[ivxlcdm]+)\b/gi,
            " "
        )
        .replace(/\b(?:deluxe|edition|expanded|remaster(?:ed)?)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function titlesLikelySame(a: string, b: string): boolean {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const la = normalizeTitleLoose(a);
    const lb = normalizeTitleLoose(b);
    if (la && lb && la === lb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    if (la && lb && (la.includes(lb) || lb.includes(la))) return true;
    const aTokens = tokenSet(na);
    const bTokens = tokenSet(nb);
    if (aTokens.size === 0 || bTokens.size === 0) return false;
    let overlap = 0;
    for (const t of aTokens) {
        if (bTokens.has(t)) overlap++;
    }
    const minSize = Math.min(aTokens.size, bTokens.size);
    return overlap >= Math.max(2, Math.floor(minSize * 0.7));
}

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
    await redisClient
        .del(ALBUM_LOOKUP_CIRCUIT_OPEN_KEY, ALBUM_LOOKUP_CIRCUIT_FAILS_KEY)
        .catch(() => {});
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

            const idsResult = await prisma.$queryRaw<{ id: string }[]>`
                SELECT a.id
                FROM "Album" a
                WHERE EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
                AND (
                    a.location = 'LIBRARY'
                    OR a."rgMbid" IN (SELECT "rgMbid" FROM "OwnedAlbum")
                    OR EXISTS (
                        SELECT 1
                        FROM "AlbumOwnershipFact" aof
                        WHERE aof."albumId" = a.id
                          AND aof."status" = 'OWNED'
                    )
                )
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
                    AND (
                        a.location = 'LIBRARY'
                        OR a."rgMbid" IN (SELECT "rgMbid" FROM "OwnedAlbum")
                        OR EXISTS (
                            SELECT 1
                            FROM "AlbumOwnershipFact" aof
                            WHERE aof."albumId" = a.id
                              AND aof."status" = 'OWNED'
                        )
                    )
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
            if (
                !albumItem ||
                (albumItem.Type !== "MusicAlbum" && albumItem.Type !== "BoxSet")
            ) {
                return res.status(404).json({ error: "Album not found" });
            }
            const albumArtists = getAlbumArtistsFromJellyfinItem(albumItem);
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
                albumArtists: albumArtists.length > 0 ? albumArtists : [artist],
                isCompilation: isCompilationAlbumFromArtists(
                    albumArtists.length > 0 ? albumArtists : [artist]
                ),
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
                albumArtistCredits: {
                    orderBy: { sortOrder: Prisma.SortOrder.asc },
                    include: {
                        artist: {
                            select: {
                                id: true,
                                name: true,
                                mbid: true,
                            },
                        },
                    },
                },
                sourceMaps: {
                    where: { source: "JELLYFIN" },
                    orderBy: { updatedAt: Prisma.SortOrder.desc },
                    take: 3,
                    select: {
                        sourceAlbumId: true,
                    },
                },
                tracks: {
                    orderBy: { trackNo: Prisma.SortOrder.asc },
                    include: {
                        trackArtistCredits: {
                            orderBy: { sortOrder: Prisma.SortOrder.asc },
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                        mbid: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        // If not in Prisma and Jellyfin mode: try album by MusicBrainz rgMbid when idParam is MBID format
        if (!album && MBID_REGEX.test(idParam) && (await isJellyfinMusicSource())) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                const mbidMissKey = albumLookupMissKey(`mbid:${idParam}`);
                const hasMissCache = redisClient.isReady
                    ? (await redisClient.get(mbidMissKey).catch(() => null)) === "1"
                    : false;
                const circuitOpen = await isAlbumLookupCircuitOpen();
                if (hasMissCache || circuitOpen) {
                    logger.debug(
                        `[Album] Skipping MBID deep lookup for ${idParam} (${hasMissCache ? "miss-cache" : "circuit-open"})`
                    );
                    return res.status(404).json({ error: "Album not found" });
                }

                let albumItem = null as Awaited<ReturnType<typeof getJellyfinAlbumByRgMbid>>;
                try {
                    albumItem = await getJellyfinAlbumByRgMbid(cfg, idParam);
                    if (albumItem) {
                        await recordAlbumLookupSuccess();
                        if (redisClient.isReady) {
                            await redisClient.del(mbidMissKey).catch(() => {});
                        }
                    } else if (redisClient.isReady) {
                        await redisClient
                            .setEx(mbidMissKey, ALBUM_LOOKUP_MISS_TTL_SECONDS, "1")
                            .catch(() => {});
                    }
                } catch (err) {
                    await recordAlbumLookupFailure("mbid-route");
                    if (redisClient.isReady) {
                        await redisClient
                            .setEx(mbidMissKey, ALBUM_LOOKUP_MISS_TTL_SECONDS, "1")
                            .catch(() => {});
                    }
                    throw err;
                }
                if (
                    albumItem &&
                    (albumItem.Type === "MusicAlbum" || albumItem.Type === "BoxSet")
                ) {
                    const resolvedId = `jellyfin:${albumItem.Id}`;
                    const tracks = await getJellyfinTracksAllForAlbum(cfg, resolvedId);
                    const albumArtists = getAlbumArtistsFromJellyfinItem(albumItem);
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
                        albumArtists: albumArtists.length > 0 ? albumArtists : [artist],
                        isCompilation: isCompilationAlbumFromArtists(
                            albumArtists.length > 0 ? albumArtists : [artist]
                        ),
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

        // New primary ownership path: AlbumOwnershipFact (source=JELLYFIN).
        const ownershipFact = await prisma.albumOwnershipFact.findUnique({
            where: {
                albumId_source: {
                    albumId: album.id,
                    source: "JELLYFIN",
                },
            },
            select: {
                status: true,
                sourceAlbumId: true,
                matchMethod: true,
                confidence: true,
            },
        });
        let isOwned = ownershipFact?.status === "OWNED";
        const sourceAlbumHints = [
            ownershipFact?.sourceAlbumId,
            ...album.sourceMaps.map((m) => m.sourceAlbumId),
        ].filter(
            (id, index, all): id is string =>
                !!id && all.indexOf(id) === index
        );

        // Compatibility fallback while we transition off OwnedAlbum reads.
        if (!isOwned && album.rgMbid) {
            const owned = await prisma.ownedAlbum.findFirst({
                where: {
                    OR: [
                        {
                            artistId: album.artistId,
                            rgMbid: album.rgMbid,
                        },
                        {
                            rgMbid: album.rgMbid,
                        },
                    ],
                },
                select: { artistId: true, rgMbid: true },
            });
            isOwned = !!owned;
        }

        // Prisma album exists but OwnedAlbum says not owned — check Jellyfin.
        // The Prisma record may come from enrichment/discovery while the actual
        // music lives in Jellyfin. If found there, serve the Jellyfin version
        // which has playable tracks.
        if (!isOwned && (await isJellyfinMusicSource())) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                let jellyfinAlbum: any = null;
                const lookupMissKey = albumLookupMissKey(
                    album.rgMbid ? `${album.id}:${album.rgMbid}` : album.id
                );
                const hasMissCache = redisClient.isReady
                    ? (await redisClient.get(lookupMissKey).catch(() => null)) === "1"
                    : false;
                const lookupCircuitOpen = await isAlbumLookupCircuitOpen();
                let attemptedExpensiveLookup = false;

                for (const sourceAlbumId of sourceAlbumHints) {
                    if (jellyfinAlbum) break;
                    jellyfinAlbum = await getJellyfinItem(
                        cfg,
                        sourceAlbumId,
                        "MusicAlbum"
                    ).catch(() => null);
                }

                if (album.rgMbid) {
                    // Fast path: syncJellyfinOwnedAlbums caches rgMbid→JellyfinID.
                    // Use that for a direct item lookup instead of scanning 2000+ albums.
                    const redisCacheKey = `jf:rgmbid:${album.rgMbid}`;
                    const cachedJfId = redisClient.isReady
                        ? await redisClient.get(redisCacheKey).catch(() => null)
                        : null;

                    if (cachedJfId) {
                        jellyfinAlbum = await getJellyfinItem(cfg, cachedJfId, "MusicAlbum").catch(
                            () => null
                        );
                    }
                    if (!jellyfinAlbum) {
                        if (hasMissCache || lookupCircuitOpen) {
                            logger.debug(
                                `[Album] Skipping rgMbid deep scan for "${album.title}" (${hasMissCache ? "miss-cache" : "circuit-open"})`
                            );
                        } else {
                            attemptedExpensiveLookup = true;
                            jellyfinAlbum = await getJellyfinAlbumByRgMbid(
                                cfg,
                                album.rgMbid
                            ).catch(async (err) => {
                                logger.debug(
                                    `[Album] Jellyfin rgMbid scan failed for "${album.title}" (${album.rgMbid}):`,
                                    err instanceof Error ? err.message : err
                                );
                                await recordAlbumLookupFailure("rgmbid-scan");
                                return null;
                            });
                        }
                        if (jellyfinAlbum && redisClient.isReady) {
                            await redisClient
                                .setEx(redisCacheKey, 30 * 24 * 3600, jellyfinAlbum.Id)
                                .catch(() => {});
                        }
                    }
                }

                if (!jellyfinAlbum && !hasMissCache && !lookupCircuitOpen) {
                    attemptedExpensiveLookup = true;
                    // MBIDs are sometimes missing or mismatched (release vs release-group).
                    // Fallback to title/artist matching in Jellyfin for robustness.
                    const normalizedTargetTitle = normalizeTitle(album.title);
                    const normalizedTargetArtist = normalizeTitle(
                        album.artist?.name ?? ""
                    );
                    const isVariousTargetArtist =
                        !!normalizedTargetArtist &&
                        isVariousArtistsName(normalizedTargetArtist);
                    let candidate:
                        | {
                              id: string;
                              title: string;
                              coverArt: string | null;
                              artist?: { id: string; name: string };
                              year?: number;
                              rgMbid?: string;
                          }
                        | undefined;
                    const isCandidateMatch = (a: {
                        title: string;
                        artist?: { id: string; name: string };
                    }) => {
                        const sameTitle = titlesLikelySame(
                            a.title,
                            normalizedTargetTitle
                        );
                        if (!sameTitle) return false;

                        if (!normalizedTargetArtist || isVariousTargetArtist) return true;

                        const normalizedCandidateArtist = normalizeTitle(
                            a.artist?.name ?? ""
                        );
                        if (!normalizedCandidateArtist) return true;
                        return (
                            normalizedCandidateArtist === normalizedTargetArtist ||
                            isVariousArtistsName(normalizedCandidateArtist)
                        );
                    };

                    // Try indexed Jellyfin search first using a few title variants.
                    const searchTerms = Array.from(
                        new Set(
                            [
                                album.title,
                                album.title.replace(/[()[\]{}]/g, " ").trim(),
                                album.title
                                    .replace(/\bbox\s*set\b/gi, "")
                                    .trim(),
                            ].filter((v) => !!v)
                        )
                    );
                    for (const searchTerm of searchTerms) {
                        if (candidate) break;
                        let offset = 0;
                        const limit = 100;
                        let pages = 0;
                        const maxPagesPerTerm = 3;
                        while (!candidate) {
                            let jfResult: Awaited<ReturnType<typeof getJellyfinAlbums>>;
                            try {
                                jfResult = await getJellyfinAlbums(cfg, {
                                    search: searchTerm,
                                    limit,
                                    offset,
                                });
                            } catch (err) {
                                logger.debug(
                                    `[Album] Jellyfin title search failed for "${searchTerm}" at offset ${offset}:`,
                                    err instanceof Error ? err.message : err
                                );
                                await recordAlbumLookupFailure("title-search");
                                break;
                            }
                            const { albums: jfAlbums, total } = jfResult;
                            if (jfAlbums.length === 0) break;
                            candidate = jfAlbums.find(isCandidateMatch);
                            if (candidate) break;
                            offset += jfAlbums.length;
                            pages += 1;
                            if (offset >= total || jfAlbums.length < limit) break;
                            if (pages >= maxPagesPerTerm) break;
                        }
                    }

                    // Intentionally avoid deep full-library scans on interactive routes.
                    // If indexed search does not find a candidate, defer reconciliation to
                    // background jobs instead of blocking this request.

                    // Extra fallback: Jellyfin can classify some releases as BoxSet.
                    // Search both MusicAlbum and BoxSet containers before giving up.
                    if (!candidate) {
                        for (const searchTerm of searchTerms) {
                            if (candidate) break;
                            let offset = 0;
                            const limit = 100;
                            let pages = 0;
                            const maxPagesPerTerm = 2;
                            while (!candidate) {
                                let containerResult: Awaited<
                                    ReturnType<typeof getJellyfinAlbumContainers>
                                >;
                                try {
                                    containerResult = await getJellyfinAlbumContainers(cfg, {
                                        search: searchTerm,
                                        limit,
                                        offset,
                                    });
                                } catch (err) {
                                    logger.debug(
                                        `[Album] Jellyfin container search failed for "${searchTerm}" at offset ${offset}:`,
                                        err instanceof Error ? err.message : err
                                    );
                                    await recordAlbumLookupFailure("container-search");
                                    break;
                                }
                                const { items, total } = containerResult;
                                if (items.length === 0) break;
                                const matched = items.find((item) =>
                                    isCandidateMatch({
                                        title: item.Name,
                                        artist: item.AlbumArtists?.[0]
                                            ? {
                                                  id: `jellyfin:${item.AlbumArtists[0].Id}`,
                                                  name: item.AlbumArtists[0].Name,
                                              }
                                            : undefined,
                                    })
                                );
                                if (matched) {
                                    candidate = {
                                        id: `jellyfin:${matched.Id}`,
                                        title: matched.Name,
                                        coverArt: getJellyfinImageUrl(
                                            cfg.url,
                                            matched.Id,
                                            matched.ImageTags?.Primary,
                                            cfg.apiKey,
                                            cfg.userId
                                        ),
                                        artist: matched.AlbumArtists?.[0]
                                            ? {
                                                  id: `jellyfin:${matched.AlbumArtists[0].Id}`,
                                                  name: matched.AlbumArtists[0].Name,
                                              }
                                            : undefined,
                                        year: matched.ProductionYear ?? undefined,
                                        rgMbid: extractRgMbid(matched.ProviderIds),
                                    };
                                    break;
                                }
                                offset += items.length;
                                pages += 1;
                                if (offset >= total || items.length < limit) break;
                                if (pages >= maxPagesPerTerm) break;
                            }
                        }
                    }
                    if (candidate?.id?.startsWith("jellyfin:")) {
                        const rawId = candidate.id.slice("jellyfin:".length);
                        jellyfinAlbum = await getJellyfinItem(
                            cfg,
                            rawId,
                            "MusicAlbum"
                        ).catch(() => null);
                    }
                } else if (!jellyfinAlbum && (hasMissCache || lookupCircuitOpen)) {
                    logger.debug(
                        `[Album] Skipping expensive Jellyfin title scan for "${album.title}" (${hasMissCache ? "miss-cache" : "circuit-open"})`
                    );
                }

                if (jellyfinAlbum) {
                    await recordAlbumLookupSuccess();
                    if (redisClient.isReady) {
                        await redisClient.del(lookupMissKey).catch(() => {});
                    }
                } else if (attemptedExpensiveLookup && redisClient.isReady) {
                    await redisClient
                        .setEx(lookupMissKey, ALBUM_LOOKUP_MISS_TTL_SECONDS, "1")
                        .catch(() => {});
                }

                if (
                    jellyfinAlbum &&
                    (jellyfinAlbum.Type === "MusicAlbum" ||
                        jellyfinAlbum.Type === "BoxSet")
                ) {
                    const sourceAlbumId = jellyfinAlbum.Id;
                    const albumArtists = getAlbumArtistsFromJellyfinItem(jellyfinAlbum);
                    const primaryAlbumArtists =
                        albumArtists.length > 0
                            ? albumArtists
                            : album.artist
                              ? [{ id: album.artist.id, name: album.artist.name }]
                              : [];
                    const method =
                        album.rgMbid &&
                        album.rgMbid === extractRgMbid(jellyfinAlbum.ProviderIds)
                            ? "RGMBID"
                            : "TITLE_ARTIST_NORMALIZED";

                    // Opportunistically heal/refresh source map + ownership fact.
                    await prisma.$transaction([
                        prisma.albumSourceMap.upsert({
                            where: {
                                source_sourceAlbumId: {
                                    source: "JELLYFIN",
                                    sourceAlbumId,
                                },
                            },
                            create: {
                                source: "JELLYFIN",
                                sourceAlbumId,
                                albumId: album.id,
                                matchMethod: method,
                                confidence: method === "RGMBID" ? 1.0 : 0.92,
                                evidence: {
                                    jellyfinTitle: jellyfinAlbum.Name || album.title,
                                    jellyfinArtist:
                                        jellyfinAlbum.AlbumArtists?.[0]?.Name ??
                                        album.artist?.name ??
                                        null,
                                    jellyfinRgMbid:
                                        extractRgMbid(jellyfinAlbum.ProviderIds) ??
                                        null,
                                },
                            },
                            update: {
                                albumId: album.id,
                                matchMethod: method,
                                confidence: method === "RGMBID" ? 1.0 : 0.92,
                                evidence: {
                                    jellyfinTitle: jellyfinAlbum.Name || album.title,
                                    jellyfinArtist:
                                        jellyfinAlbum.AlbumArtists?.[0]?.Name ??
                                        album.artist?.name ??
                                        null,
                                    jellyfinRgMbid:
                                        extractRgMbid(jellyfinAlbum.ProviderIds) ??
                                        null,
                                },
                            },
                        }),
                        prisma.albumOwnershipFact.upsert({
                            where: {
                                albumId_source: {
                                    albumId: album.id,
                                    source: "JELLYFIN",
                                },
                            },
                            create: {
                                albumId: album.id,
                                source: "JELLYFIN",
                                sourceAlbumId,
                                status: "OWNED",
                                matchMethod: method,
                                confidence: method === "RGMBID" ? 1.0 : 0.92,
                                evidence: {
                                    jellyfinTitle: jellyfinAlbum.Name || album.title,
                                    jellyfinArtist:
                                        jellyfinAlbum.AlbumArtists?.[0]?.Name ??
                                        album.artist?.name ??
                                        null,
                                    jellyfinRgMbid:
                                        extractRgMbid(jellyfinAlbum.ProviderIds) ??
                                        null,
                                },
                            },
                            update: {
                                sourceAlbumId,
                                status: "OWNED",
                                matchMethod: method,
                                confidence: method === "RGMBID" ? 1.0 : 0.92,
                                observedAt: new Date(),
                                evidence: {
                                    jellyfinTitle: jellyfinAlbum.Name || album.title,
                                    jellyfinArtist:
                                        jellyfinAlbum.AlbumArtists?.[0]?.Name ??
                                        album.artist?.name ??
                                        null,
                                    jellyfinRgMbid:
                                        extractRgMbid(jellyfinAlbum.ProviderIds) ??
                                        null,
                                },
                            },
                        }),
                        prisma.albumArtistCredit.deleteMany({
                            where: {
                                albumId: album.id,
                                source: "JELLYFIN",
                            },
                        }),
                        ...(primaryAlbumArtists.length > 0
                            ? [
                                  prisma.albumArtistCredit.createMany({
                                      data: primaryAlbumArtists.map((a, idx) => ({
                                          albumId: album.id,
                                          artistId:
                                              a.id && !a.id.startsWith("jellyfin:")
                                                  ? a.id
                                                  : null,
                                          displayName: a.name,
                                          normalizedDisplayName: normalizeTitle(a.name),
                                          role: isVariousArtistsName(normalizeTitle(a.name))
                                              ? "COMPILATION"
                                              : "PRIMARY",
                                          sortOrder: idx,
                                          source: "JELLYFIN",
                                          sourceArtistId: a.id.startsWith("jellyfin:")
                                              ? a.id.slice("jellyfin:".length)
                                              : null,
                                          confidence: method === "RGMBID" ? 1.0 : 0.92,
                                          evidence: {
                                              jellyfinAlbumTitle:
                                                  jellyfinAlbum.Name || album.title,
                                          },
                                      })),
                                  }),
                              ]
                            : []),
                        prisma.album.update({
                            where: { id: album.id },
                            data: {
                                isCompilation:
                                    isCompilationAlbumFromArtists(primaryAlbumArtists),
                            },
                        }),
                    ]);

                    const jfId = `jellyfin:${jellyfinAlbum.Id}`;
                    const tracks = await getJellyfinTracksAllForAlbum(cfg, jfId);
                    if (album.tracks.length > 0) {
                        const jellyfinTrackByTitle = new Map<
                            string,
                            { id: string; name: string }
                        >();
                        for (const t of tracks) {
                            const key = normalizeTitle(t.title);
                            if (!key || jellyfinTrackByTitle.has(key)) continue;
                            if (!t.artist?.name) continue;
                            jellyfinTrackByTitle.set(key, {
                                id: t.artist.id,
                                name: t.artist.name,
                            });
                        }

                        const trackCreditRows = album.tracks
                            .map((nativeTrack, idx) => {
                                const matched = jellyfinTrackByTitle.get(
                                    normalizeTitle(nativeTrack.title)
                                );
                                if (!matched?.name) return null;
                                return {
                                    trackId: nativeTrack.id,
                                    artistId: null as string | null,
                                    displayName: matched.name,
                                    normalizedDisplayName: normalizeTitle(matched.name),
                                    role: "PRIMARY" as const,
                                    sortOrder: 0,
                                    source: "JELLYFIN" as const,
                                    sourceArtistId: matched.id.startsWith("jellyfin:")
                                        ? matched.id.slice("jellyfin:".length)
                                        : null,
                                    confidence: 0.9,
                                    evidence: {
                                        jellyfinTrackIndex: idx,
                                        jellyfinAlbumId: jellyfinAlbum.Id,
                                    },
                                };
                            })
                            .filter((row): row is NonNullable<typeof row> => !!row);

                        await prisma.$transaction([
                            prisma.trackArtistCredit.deleteMany({
                                where: {
                                    trackId: { in: album.tracks.map((t) => t.id) },
                                    source: "JELLYFIN",
                                },
                            }),
                            ...(trackCreditRows.length > 0
                                ? [
                                      prisma.trackArtistCredit.createMany({
                                          data: trackCreditRows,
                                      }),
                                  ]
                                : []),
                        ]);
                    }
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
                        albumArtists:
                            primaryAlbumArtists.length > 0
                                ? primaryAlbumArtists
                                : [artist],
                        isCompilation: isCompilationAlbumFromArtists(
                            primaryAlbumArtists.length > 0
                                ? primaryAlbumArtists
                                : [artist]
                        ),
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

        const albumArtists =
            album.albumArtistCredits.length > 0
                ? album.albumArtistCredits.map((credit) => ({
                      id: credit.artist?.id ?? credit.artistId ?? "",
                      name: credit.artist?.name ?? credit.displayName,
                      mbid: credit.artist?.mbid ?? null,
                  }))
                : album.artist
                  ? [
                        {
                            id: album.artist.id,
                            name: album.artist.name,
                            mbid: album.artist.mbid ?? null,
                        },
                    ]
                  : [];
        const primaryArtist = albumArtists[0] ?? album.artist;
        const tracks = album.tracks.map((track) => {
            const primaryTrackCredit = track.trackArtistCredits[0];
            const trackArtist = primaryTrackCredit
                ? {
                      id: primaryTrackCredit.artist?.id ?? primaryTrackCredit.artistId ?? "",
                      name:
                          primaryTrackCredit.artist?.name ??
                          primaryTrackCredit.displayName,
                      mbid: primaryTrackCredit.artist?.mbid ?? null,
                  }
                : primaryArtist
                  ? {
                        id: primaryArtist.id,
                        name: primaryArtist.name,
                        mbid: primaryArtist.mbid ?? null,
                    }
                  : undefined;
            return {
                ...track,
                artist: trackArtist,
            };
        });

        res.json({
            ...album,
            artist: primaryArtist,
            albumArtists,
            tracks,
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
