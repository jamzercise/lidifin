import { Router } from "express";
import { logger, JELLYFIN_UNREACHABLE_MESSAGE, ARTIST_SORT_MAP, MAX_LIMIT } from "./_helpers";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { config } from "../../config";
import path from "path";
import fs from "fs";
import { lastFmService } from "../../services/lastfm";
import { deezerService } from "../../services/deezer";
import { musicBrainzService } from "../../services/musicbrainz";
import { dataCacheService } from "../../services/dataCache";
import {
    backfillAllArtistCounts,
    isBackfillNeeded,
    getBackfillProgress,
    isBackfillInProgress,
} from "../../services/artistCountsService";
import {
    isImageBackfillNeeded,
    getImageBackfillProgress,
    backfillAllImages,
} from "../../services/imageBackfill";
import {
    getMergedGenres,
    getArtistDisplaySummary,
} from "../../utils/metadataOverrides";
import {
    isJellyfinMusicSource,
    getJellyfinConfig,
    getJellyfinAlbums,
    getJellyfinArtists,
    getJellyfinAlbumsAllForArtist,
    getJellyfinArtistAlbumCounts,
    getJellyfinTracks,
    getJellyfinItem,
    getJellyfinArtistByName,
    getJellyfinImageUrl,
    extractArtistMbid,
} from "../../services/jellyfin";
import { enrichJellyfinArtist } from "../../services/jellyfinArtistEnrichment";
import {
    getArtistNameAliases,
    normalizeArtistName,
} from "../../utils/artistNormalization";

const router = Router();

function normalizeAlbumTitle(value: string | null | undefined): string {
    return (value ?? "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function albumTitlesLikelySame(a: string, b: string): boolean {
    const na = normalizeAlbumTitle(a);
    const nb = normalizeAlbumTitle(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    return na.includes(nb) || nb.includes(na);
}

function albumIdentityKey(album: {
    rgMbid?: string | null;
    title: string;
    year?: number | null;
}): string {
    if (album.rgMbid) return `rg:${album.rgMbid}`;
    return `title:${normalizeAlbumTitle(album.title)}:${album.year ?? "unknown"}`;
}

function pickBestArtistCandidate<
    T extends {
        id: string;
        mbid: string;
        name: string;
        normalizedName: string;
        heroUrl: string | null;
        albums: unknown[];
        ownedAlbums: unknown[];
        similarArtistsJson?: unknown;
    }
>(
    candidates: T[],
    targetAliases: string[]
): T | null {
    if (candidates.length === 0) return null;
    const aliasSet = new Set(targetAliases.map((a) => normalizeArtistName(a)));

    let best = candidates[0];
    let bestScore = -1;
    for (const c of candidates) {
        let score = 0;
        const validMbid = !!c.mbid && !c.mbid.startsWith("temp-");
        if (validMbid) score += 40;
        if (c.heroUrl) score += 15;
        if (Array.isArray(c.similarArtistsJson) && c.similarArtistsJson.length > 0) {
            score += 15;
        }
        score += c.albums.length * 8;
        score += c.ownedAlbums.length * 12;
        if (aliasSet.has(normalizeArtistName(c.name))) score += 20;
        if (aliasSet.has(c.normalizedName)) score += 10;

        if (score > bestScore) {
            best = c;
            bestScore = score;
        }
    }
    return best;
}

router.get("/artists", async (req, res) => {
    try {
        const {
            query = "",
            limit: limitParam = "50",
            offset: offsetParam = "0",
            filter = "owned", // owned (default), discovery, all
            cursor, // Optional cursor for cursor-based pagination
            sortBy = "name",
        } = req.query;

        const limit = Math.min(
            parseInt(limitParam as string, 10) || 50,
            MAX_LIMIT
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        if (await isJellyfinMusicSource()) {
            const cfg = await getJellyfinConfig();
            if (!cfg) {
                logger.warn(
                    "[Library] Jellyfin is music source but config is null (missing URL, API key, or User ID?)"
                );
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
            try {
                const { artists, total } = await getJellyfinArtists(cfg, {
                    limit,
                    offset,
                    search: (query as string) || undefined,
                });
                const artistIds = artists.map((a) => a.id);
                const albumCountMap = await getJellyfinArtistAlbumCounts(
                    cfg,
                    artistIds,
                    10
                );
                logger.info(
                    `[Library] Jellyfin artists: returned ${artists.length} of ${total}`
                );
                return res.json({
                    artists: artists.map((a) => ({
                        id: a.id,
                        name: a.name,
                        mbid: a.mbid ?? null,
                        heroUrl: a.coverArt ?? null,
                        coverArt: a.coverArt ?? null,
                        albumCount: albumCountMap.get(a.id) ?? 0,
                        trackCount: 0,
                    })),
                    total,
                    offset,
                    limit,
                });
            } catch (err: any) {
                logger.warn("[Library] Jellyfin artists error:", err?.message);
                return res.status(503).json({
                    error: JELLYFIN_UNREACHABLE_MESSAGE,
                    jellyfin: true,
                });
            }
        }

        const orderBy = ARTIST_SORT_MAP[sortBy as string] ?? { name: "asc" as const };

        // Build WHERE clause using denormalized counts (fast indexed lookup)
        // This replaces the expensive OR with nested some conditions
        let where: any = {};

        if (filter === "owned") {
            // Artists with library albums OR liked discovery albums (via ownedAlbums)
            where.OR = [
                { libraryAlbumCount: { gt: 0 } },
                { ownedAlbums: { some: {} } },
                {
                    albums: {
                        some: {
                            ownershipFacts: {
                                some: {
                                    status: "OWNED",
                                    source: "JELLYFIN",
                                },
                            },
                        },
                    },
                },
            ];
        } else if (filter === "discovery") {
            // Artists with ONLY discovery albums (no library albums)
            where.discoveryAlbumCount = { gt: 0 };
            where.libraryAlbumCount = 0;
        } else {
            // "all" - any artists with albums that have tracks
            where.OR = [
                { libraryAlbumCount: { gt: 0 } },
                { discoveryAlbumCount: { gt: 0 } },
            ];
        }

        // Add search query if provided
        if (query) {
            where.name = { contains: query as string, mode: "insensitive" };
        }

        // Execute queries with timeout to prevent cascade failures
        const [artists, total] = await prisma.$transaction(
            async (tx) => {
                // Build findMany args - cursor or offset pagination
                const findManyArgs: Parameters<typeof tx.artist.findMany>[0] = {
                    where,
                    take: limit,
                    orderBy,
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        userHeroUrl: true,
                        libraryAlbumCount: true,
                        discoveryAlbumCount: true,
                        totalTrackCount: true,
                    },
                };

                // Use cursor-based pagination if cursor provided, otherwise offset
                if (cursor) {
                    findManyArgs.cursor = { id: cursor as string };
                    findManyArgs.skip = 1;
                } else {
                    findManyArgs.skip = offset;
                }

                return Promise.all([
                    tx.artist.findMany(findManyArgs),
                    tx.artist.count({ where }),
                ]);
            },
            { timeout: 30000 } // 30 second timeout as safety net
        );

        // Use DataCacheService for batch image lookup (DB + Redis, no API calls for lists)
        const imageMap = await dataCacheService.getArtistImagesBatch(
            artists.map((a) => ({
                id: a.id,
                heroUrl: a.heroUrl,
                userHeroUrl: a.userHeroUrl,
            }))
        );

        const artistsWithImages = artists.map((artist) => {
            const coverArt =
                imageMap.get(artist.id) || artist.heroUrl || null;

            // Use denormalized counts based on filter
            const albumCount =
                filter === "discovery"
                    ? artist.discoveryAlbumCount
                    : filter === "all"
                    ? artist.libraryAlbumCount + artist.discoveryAlbumCount
                    : artist.libraryAlbumCount;

            return {
                id: artist.id,
                mbid: artist.mbid,
                name: artist.name,
                heroUrl: coverArt,
                coverArt, // Alias for frontend consistency
                albumCount,
                trackCount: artist.totalTrackCount,
            };
        });

        // Include cursor for next page (last artist ID)
        const nextCursor =
            artists.length === limit ? artists[artists.length - 1].id : null;

        res.json({
            artists: artistsWithImages,
            total,
            offset,
            limit,
            nextCursor, // For cursor-based pagination
        });
    } catch (error: any) {
        logger.error("[Library] Get artists error:", error?.message || error);
        logger.error("[Library] Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to fetch artists",
            details: error?.message,
        });
    }
});

// GET /library/artist-counts/status - Check artist counts backfill status
router.get("/artist-counts/status", async (req, res) => {
    try {
        const [needsBackfill, progress] = await Promise.all([
            isBackfillNeeded(),
            getBackfillProgress(),
        ]);

        res.json({
            needsBackfill,
            ...progress,
        });
    } catch (error: any) {
        logger.error("[ArtistCounts] Status check error:", error?.message);
        res.status(500).json({ error: "Failed to check status" });
    }
});

// POST /library/artist-counts/backfill - Trigger artist counts backfill
router.post("/artist-counts/backfill", async (req, res) => {
    try {
        if (isBackfillInProgress()) {
            return res.json({
                message: "Backfill already in progress",
                status: "processing",
            });
        }

        // Return immediately, run backfill in background
        res.json({ message: "Backfill started", status: "processing" });

        // Run backfill (non-blocking)
        backfillAllArtistCounts((processed, total) => {
            if (processed % 100 === 0) {
                logger.debug(`[ArtistCounts] Progress: ${processed}/${total}`);
            }
        }).catch((error) => {
            logger.error("[ArtistCounts] Backfill failed:", error);
        });
    } catch (error: any) {
        logger.error("[ArtistCounts] Backfill trigger error:", error?.message);
        res.status(500).json({ error: "Failed to start backfill" });
    }
});

// GET /library/image-backfill/status - Check image backfill status
router.get("/image-backfill/status", async (req, res) => {
    try {
        const [status, progress] = await Promise.all([
            isImageBackfillNeeded(),
            getImageBackfillProgress(),
        ]);

        res.json({
            ...status,
            ...progress,
        });
    } catch (error: any) {
        logger.error("[ImageBackfill] Status check error:", error?.message);
        res.status(500).json({ error: "Failed to check status" });
    }
});

// POST /library/image-backfill/start - Trigger image backfill
router.post("/image-backfill/start", async (req, res) => {
    try {
        const progress = getImageBackfillProgress();
        if (progress.inProgress) {
            return res.json({
                message: "Image backfill already in progress",
                status: "processing",
                progress,
            });
        }

        // Return immediately, run backfill in background
        res.json({ message: "Image backfill started", status: "processing" });

        // Run backfill (non-blocking)
        backfillAllImages().catch((error) => {
            logger.error("[ImageBackfill] Backfill failed:", error);
        });
    } catch (error: any) {
        logger.error("[ImageBackfill] Backfill trigger error:", error?.message);
        res.status(500).json({ error: "Failed to start image backfill" });
    }
});

// POST /library/backfill-genres - Backfill genres for artists missing them
router.post("/backfill-genres", async (req, res) => {
    try {
        // Find artists that have been enriched but have no genres
        const artistsToBackfill = await prisma.artist.findMany({
            where: {
                enrichmentStatus: "completed",
                OR: [
                    { genres: { equals: Prisma.DbNull } },
                    { genres: { equals: [] } },
                ],
            },
            select: { id: true, name: true, mbid: true },
            take: 50, // Process in batches
        });

        if (artistsToBackfill.length === 0) {
            return res.json({
                message: "No artists need genre backfill",
                count: 0,
            });
        }

        // Reset these artists to pending so enrichment worker re-processes them
        const result = await prisma.artist.updateMany({
            where: {
                id: { in: artistsToBackfill.map((a) => a.id) },
            },
            data: {
                enrichmentStatus: "pending",
                lastEnriched: null,
            },
        });

        logger.info(
            `[Backfill] Reset ${result.count} artists for genre enrichment`
        );

        res.json({
            message: `Reset ${result.count} artists for genre enrichment`,
            count: result.count,
            artists: artistsToBackfill.map((a) => a.name).slice(0, 10),
        });
    } catch (error: any) {
        logger.error("[Backfill] Genre backfill error:", error?.message);
        res.status(500).json({ error: "Failed to backfill genres" });
    }
});

// GET /library/artists/:id/enrichment
// Returns enrichment only (bio, similarArtists, discoveryAlbums, topTracks). Used for two-phase artist load.
router.get("/artists/:id/enrichment", async (req, res) => {
    try {
        const idParam = decodeURIComponent(req.params.id);
        if (!(await isJellyfinMusicSource())) {
            return res.status(404).json({ error: "Enrichment only available for Jellyfin artists" });
        }
        const cfg = await getJellyfinConfig();
        if (!cfg) return res.status(404).json({ error: "Jellyfin not configured" });

        let artistItem: Awaited<ReturnType<typeof getJellyfinArtistByName>> = null;
        if (idParam.startsWith("jellyfin:")) {
            const rawId = idParam.slice("jellyfin:".length);
            const item = await getJellyfinItem(cfg, rawId);
            if (item?.Type === "MusicArtist") artistItem = item;
        }
        if (!artistItem) {
            artistItem = await getJellyfinArtistByName(cfg, idParam);
        }
        if (!artistItem || artistItem.Type !== "MusicArtist") {
            return res.status(404).json({ error: "Artist not found" });
        }

        const resolvedId = `jellyfin:${artistItem.Id}`;
        const [albums, topTracksResult] = await Promise.all([
            getJellyfinAlbumsAllForArtist(cfg, resolvedId),
            getJellyfinTracks(cfg, { artistId: resolvedId, limit: 10 }),
        ]);
        const topTracks = topTracksResult.tracks;
        const rawName = (artistItem as any).Name ?? (artistItem as any).name;
        const artistName =
            rawName && rawName !== artistItem.Id && !rawName.startsWith("jellyfin:")
                ? rawName
                : albums[0]?.artist?.name ?? "Unknown Artist";
        const coverArt = artistItem.ImageTags?.Primary
            ? getJellyfinImageUrl(
                  cfg.url,
                  artistItem.Id,
                  artistItem.ImageTags.Primary,
                  cfg.apiKey,
                  cfg.userId
              )
            : undefined;
        const mbid = extractArtistMbid((artistItem as any).ProviderIds);

        const enrichment = await enrichJellyfinArtist(artistName, {
            mbid: mbid ?? undefined,
            existingCoverArt: coverArt ?? undefined,
        });
        if (!enrichment) {
            return res.json({
                bio: null,
                image: null,
                genres: [],
                listeners: undefined,
                playcount: undefined,
                similarArtists: [],
                discoveryAlbums: [],
                topTracks: topTracks.map((t) => ({
                    id: t.id,
                    title: t.title,
                    duration: t.duration,
                    artist: t.artist,
                    album: t.album,
                })),
            });
        }

        const ownedRgMbids = new Set(albums.map((a) => a.rgMbid).filter(Boolean));
        const discoveryAlbums = enrichment.discoveryAlbums
            .filter((d) => !ownedRgMbids.has(d.rgMbid))
            .map((d) => ({
                id: d.id,
                title: d.title,
                coverArt: d.coverUrl,
                coverUrl: d.coverUrl,
                artist: { name: artistName },
                year: d.year,
                rgMbid: d.rgMbid,
                owned: false,
                source: "database" as const,
                tracks: [],
            }));
        const effectiveTopTracks =
            enrichment.topTracks?.length
                ? enrichment.topTracks
                : topTracks.map((t) => ({
                      id: t.id,
                      title: t.title,
                      duration: t.duration,
                      artist: t.artist,
                      album: t.album,
                  }));

        return res.json({
            bio: enrichment.bio,
            image: enrichment.image ?? coverArt ?? null,
            genres: enrichment.genres ?? [],
            listeners: enrichment.listeners,
            playcount: enrichment.playcount,
            similarArtists: enrichment.similarArtists ?? [],
            discoveryAlbums,
            topTracks: effectiveTopTracks,
        });
    } catch (err: any) {
        logger.error("[Library] Artist enrichment error:", err);
        res.status(500).json({ error: err.message ?? "Enrichment failed" });
    }
});

// GET /library/artists/:id
// Resolves by: Prisma (id, name, mbid) or Jellyfin by name (e.g. /artist/Lucero).
// Artist URLs use /artist/{mbid} or /artist/{artist_name} — not Jellyfin UUID.
router.get("/artists/:id", async (req, res) => {
    try {
        const idParam = decodeURIComponent(req.params.id);
        const artistInclude = {
            albums: {
                orderBy: { year: Prisma.SortOrder.desc },
                include: {
                    tracks: {
                        orderBy: { trackNo: Prisma.SortOrder.asc },
                        take: 10, // Top tracks
                        include: {
                            album: {
                                select: {
                                    id: true,
                                    title: true,
                                    coverUrl: true,
                                },
                            },
                        },
                    },
                },
            },
            ownedAlbums: true,
            // Note: similarFrom (FK-based) is no longer used for display
            // We now use similarArtistsJson which is fetched by default
        };

        // Resolve with alias-aware artist matching:
        // - "The Books" and "Books, The" should map to the same artist row.
        const decodedName = decodeURIComponent(idParam);
        const artistAliases = getArtistNameAliases(decodedName);
        const normalizedAliases = Array.from(
            new Set(artistAliases.map((a) => normalizeArtistName(a)))
        );
        const isMbidFormat = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idParam);
        const artistCandidates = await prisma.artist.findMany({
            where: {
                OR: [
                    { id: idParam },
                    ...artistAliases.map((alias) => ({
                        name: { equals: alias, mode: "insensitive" as const },
                    })),
                    ...(normalizedAliases.length > 0
                        ? [{ normalizedName: { in: normalizedAliases } }]
                        : []),
                    ...(isMbidFormat ? [{ mbid: idParam }] : []),
                ],
            },
            include: artistInclude,
            take: 10,
        });
        let artist = pickBestArtistCandidate(artistCandidates, artistAliases);

        // If not in Prisma and Jellyfin mode: try artist by jellyfin:uuid or by name (e.g. /artist/Lucero)
        if (!artist && (await isJellyfinMusicSource())) {
            const cfg = await getJellyfinConfig();
            if (cfg) {
                let artistItem: Awaited<ReturnType<typeof getJellyfinArtistByName>> = null;
                if (idParam.startsWith("jellyfin:")) {
                    const rawId = idParam.slice("jellyfin:".length);
                    const item = await getJellyfinItem(cfg, rawId);
                    if (item?.Type === "MusicArtist") artistItem = item;
                }
                if (!artistItem) {
                    for (const alias of artistAliases) {
                        artistItem = await getJellyfinArtistByName(cfg, alias);
                        if (artistItem) break;
                    }
                }
                if (artistItem && artistItem.Type === "MusicArtist") {
                    const resolvedId = `jellyfin:${artistItem.Id}`;
                    const [albums, topTracksResult] = await Promise.all([
                        getJellyfinAlbumsAllForArtist(cfg, resolvedId),
                        getJellyfinTracks(cfg, { artistId: resolvedId, limit: 10 }),
                    ]);
                    const topTracks = topTracksResult.tracks;
                    const rawName = (artistItem as any).Name ?? (artistItem as any).name;
                    const artistName =
                        rawName && rawName !== artistItem.Id && !rawName.startsWith("jellyfin:")
                            ? rawName
                            : albums[0]?.artist?.name ?? "Unknown Artist";
                    let coverArt = artistItem.ImageTags?.Primary
                        ? getJellyfinImageUrl(
                              cfg.url,
                              artistItem.Id,
                              artistItem.ImageTags.Primary,
                              cfg.apiKey,
                              cfg.userId
                          )
                        : undefined;
                    if (!coverArt && albums[0]?.coverArt) coverArt = albums[0].coverArt;
                    const ownedAlbums = albums.map((a) => ({
                        id: a.id,
                        title: a.title,
                        coverArt: a.coverArt,
                        coverUrl: a.coverArt,
                        artist: a.artist,
                        year: a.year,
                        rgMbid: a.rgMbid,
                        owned: true,
                        source: "database" as const,
                        tracks: [],
                    }));
                    // Two-phase: return minimal artist first (no enrichment). Frontend fetches /library/artists/:id/enrichment separately.
                    return res.json({
                        id: resolvedId,
                        name: artistName,
                        coverArt: coverArt ?? undefined,
                        heroUrl: coverArt ?? undefined,
                        image: coverArt ?? undefined,
                        bio: null,
                        genres: [],
                        listeners: undefined,
                        playcount: undefined,
                        albums: ownedAlbums,
                        appearsOn: [],
                        topTracks: topTracks.map((t) => ({
                            id: t.id,
                            title: t.title,
                            duration: t.duration,
                            artist: t.artist,
                            album: t.album,
                        })),
                        similarArtists: [],
                    });
                }
            }
        }

        if (!artist) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // For enriched artists with ownedAlbums, skip expensive MusicBrainz calls.
        // Only fetch from MusicBrainz if the artist hasn't been enriched yet.
        let albumsWithOwnership = [];
        const aliasCandidates =
            artistCandidates.length > 0 ? artistCandidates : [artist];
        const aliasCandidateIds = Array.from(
            new Set(aliasCandidates.map((c) => c.id))
        );
        const normalizedArtistNames = Array.from(
            new Set([
                ...normalizedAliases,
                ...aliasCandidates
                    .map((c) => c.normalizedName?.trim())
                    .filter((n): n is string => !!n),
            ])
        );
        const ownedRgMbids = new Set(
            aliasCandidates.flatMap((c) => c.ownedAlbums.map((o) => o.rgMbid))
        );

        // Merge alias-sibling native albums so split artists still show one
        // complete owned discography during read-time resolution.
        const mergedNativeAlbumsByKey = new Map<
            string,
            (typeof artist.albums)[number]
        >();
        for (const candidate of aliasCandidates) {
            for (const nativeAlbum of candidate.albums) {
                const key = albumIdentityKey(nativeAlbum);
                const existing = mergedNativeAlbumsByKey.get(key);
                if (!existing) {
                    mergedNativeAlbumsByKey.set(key, nativeAlbum);
                    continue;
                }
                const existingTracks = existing.tracks?.length ?? 0;
                const candidateTracks = nativeAlbum.tracks?.length ?? 0;
                if (candidateTracks > existingTracks) {
                    mergedNativeAlbumsByKey.set(key, nativeAlbum);
                }
            }
        }
        const mergedNativeAlbums = Array.from(mergedNativeAlbumsByKey.values());

        // If artist has temp MBID, try to find real MBID by searching MusicBrainz
        let effectiveMbid = artist.mbid;
        if (!effectiveMbid || effectiveMbid.startsWith("temp-")) {
            logger.debug(
                ` Artist has temp/no MBID, searching MusicBrainz for ${artist.name}...`
            );
            try {
                let searchResults: Array<{ id: string }> = [];
                for (const alias of getArtistNameAliases(artist.name)) {
                    searchResults = await musicBrainzService.searchArtist(alias, 1);
                    if (searchResults.length > 0) break;
                }
                if (searchResults.length > 0) {
                    effectiveMbid = searchResults[0].id;
                    logger.debug(`  Found MBID: ${effectiveMbid}`);

                    // Update database with real MBID for future use (skip if duplicate)
                    try {
                        await prisma.artist.update({
                            where: { id: artist.id },
                            data: { mbid: effectiveMbid },
                        });
                    } catch (mbidError: any) {
                        // If MBID already exists for another artist, just log and continue
                        if (mbidError.code === "P2002") {
                            logger.debug(
                                `MBID ${effectiveMbid} already exists for another artist, skipping update`
                            );
                        } else {
                            logger.error(
                                `  ✗ Failed to update MBID:`,
                                mbidError
                            );
                        }
                    }
                } else {
                    logger.debug(
                        `  ✗ No MusicBrainz match found for ${artist.name}`
                    );
                }
            } catch (error) {
                logger.error(` MusicBrainz search failed:`, error);
            }
        }

        // Albums from database have actual tracks on disk - they MUST show as owned
        const dbAlbums = mergedNativeAlbums.map((album) => ({
            ...album,
            owned: true, // If it's in the database with tracks, user owns it!
            coverArt: album.coverUrl,
            source: "database" as const,
        }));
        const appearsOnDbAlbumsRaw = await prisma.album.findMany({
            where: {
                artistId: { notIn: aliasCandidateIds },
                albumArtistCredits: {
                    some: {
                        OR: [
                            { artistId: { in: aliasCandidateIds } },
                            ...(normalizedArtistNames.length > 0
                                ? [
                                      {
                                          normalizedDisplayName: {
                                              in: normalizedArtistNames,
                                          },
                                      },
                                  ]
                                : []),
                        ],
                    },
                },
            },
            orderBy: { year: Prisma.SortOrder.desc },
            include: {
                artist: true,
                tracks: {
                    orderBy: { trackNo: Prisma.SortOrder.asc },
                    take: 10,
                    include: {
                        album: {
                            select: {
                                id: true,
                                title: true,
                                coverUrl: true,
                            },
                        },
                    },
                },
            },
        });
        const appearsOnDbAlbums = appearsOnDbAlbumsRaw.map((album) => ({
            ...album,
            owned: true,
            coverArt: album.coverUrl,
            source: "database" as const,
        }));

        logger.debug(
            `[Artist] Found ${dbAlbums.length} albums from database (actual owned files)`
        );

        // Always fetch discography if we have a valid MBID - users need to see what's available
        const shouldFetchDiscography =
            effectiveMbid && !effectiveMbid.startsWith("temp-");

        if (shouldFetchDiscography) {
            try {
                // Check Redis cache first (cache for 24 hours)
                const discoCacheKey = `discography:${effectiveMbid}`;
                let releaseGroups: any[] = [];

                const cachedDisco = await redisClient.get(discoCacheKey);
                if (cachedDisco && cachedDisco !== "NOT_FOUND") {
                    releaseGroups = JSON.parse(cachedDisco);
                    logger.debug(
                        `[Artist] Using cached discography (${releaseGroups.length} albums)`
                    );
                } else {
                    logger.debug(
                        `[Artist] Fetching discography from MusicBrainz...`
                    );
                    releaseGroups = await musicBrainzService.getReleaseGroups(
                        effectiveMbid,
                        ["album", "ep"],
                        100
                    );
                    // Cache for 24 hours
                    await redisClient.setEx(
                        discoCacheKey,
                        24 * 60 * 60,
                        JSON.stringify(releaseGroups)
                    );
                }

                logger.debug(
                    `  Got ${releaseGroups.length} albums from MusicBrainz (before filtering)`
                );

                // Filter out live albums, compilations, soundtracks, remixes, etc.
                const excludedSecondaryTypes = [
                    "Live",
                    "Compilation",
                    "Soundtrack",
                    "Remix",
                    "DJ-mix",
                    "Mixtape/Street",
                    "Demo",
                    "Interview",
                    "Audio drama",
                    "Audiobook",
                    "Spokenword",
                ];

                const filteredReleaseGroups = releaseGroups.filter(
                    (rg: any) => {
                        // Keep if no secondary types (pure studio album/EP)
                        if (
                            !rg["secondary-types"] ||
                            rg["secondary-types"].length === 0
                        ) {
                            return true;
                        }
                        // Exclude if any secondary type matches our exclusion list
                        return !rg["secondary-types"].some((type: string) =>
                            excludedSecondaryTypes.includes(type)
                        );
                    }
                );

                logger.debug(
                    `  Filtered to ${filteredReleaseGroups.length} studio albums/EPs`
                );

                // Batch-check OwnedAlbum by rgMbid regardless of artistId.
                // syncJellyfinOwnedAlbums may attach records to a different native
                // artistId than the one being viewed, so we need a cross-artist lookup.
                const mbRgMbids = filteredReleaseGroups.map((rg: any) => rg.id);
                let globalOwnedRgMbids = new Set(ownedRgMbids);
                if (mbRgMbids.length > 0) {
                    try {
                        // Primary path: canonical ownership facts.
                        const factOwned = await prisma.album.findMany({
                            where: {
                                rgMbid: { in: mbRgMbids },
                                ownershipFacts: {
                                    some: { status: "OWNED", source: "JELLYFIN" },
                                },
                            },
                            select: { rgMbid: true },
                        });
                        for (const o of factOwned) globalOwnedRgMbids.add(o.rgMbid);

                        // Compatibility fallback while transitioning from OwnedAlbum reads.
                        const legacyOwned = await prisma.ownedAlbum.findMany({
                            where: { rgMbid: { in: mbRgMbids } },
                            select: { rgMbid: true },
                        });
                        for (const o of legacyOwned) globalOwnedRgMbids.add(o.rgMbid);
                    } catch {
                        // Non-critical: fall back to artist-scoped set
                    }
                }

                // Transform MusicBrainz release groups to album format
                // PERFORMANCE: Only check Redis cache for covers, don't make API calls
                // This makes artist pages load instantly after the first visit
                const mbAlbums = await Promise.all(
                    filteredReleaseGroups.map(async (rg: any) => {
                        let coverUrl = null;

                        // Only check Redis cache - don't make external API calls
                        // Covers will be fetched lazily by the frontend or during enrichment
                        const cacheKey = `caa:${rg.id}`;
                        try {
                            const cached = await redisClient.get(cacheKey);
                            if (cached && cached !== "NOT_FOUND") {
                                coverUrl = cached;
                            }
                        } catch (err) {
                            // Redis error, continue without cover
                        }

                        return {
                            id: rg.id,
                            rgMbid: rg.id,
                            title: rg.title,
                            year: rg["first-release-date"]
                                ? parseInt(
                                      rg["first-release-date"].substring(0, 4)
                                  )
                                : null,
                            type: rg["primary-type"],
                            coverUrl,
                            coverArt: coverUrl,
                            artistId: artist.id,
                            owned: globalOwnedRgMbids.has(rg.id),
                            trackCount: 0,
                            tracks: [],
                            source: "musicbrainz" as const,
                        };
                    })
                );

                // Merge database albums with MusicBrainz albums
                // Database albums take precedence (they have actual files!)
                const dbAlbumTitles = new Set(
                    dbAlbums.map((a) => a.title.toLowerCase())
                );
                const mbAlbumsFiltered = mbAlbums.filter(
                    (a) => !dbAlbumTitles.has(a.title.toLowerCase())
                );

                albumsWithOwnership = [...dbAlbums, ...mbAlbumsFiltered];

                logger.debug(
                    `  Total albums: ${albumsWithOwnership.length} (${dbAlbums.length} owned from database, ${mbAlbumsFiltered.length} from MusicBrainz)`
                );
                logger.debug(
                    `  Owned: ${
                        albumsWithOwnership.filter((a) => a.owned).length
                    }, Available: ${
                        albumsWithOwnership.filter((a) => !a.owned).length
                    }`
                );
            } catch (error) {
                logger.error(`Failed to fetch MusicBrainz discography:`, error);
                // Just use database albums
                albumsWithOwnership = dbAlbums;
            }
        } else {
            // No valid MBID - just use database albums
            logger.debug(
                `[Artist] No valid MBID, using ${dbAlbums.length} albums from database`
            );
            albumsWithOwnership = dbAlbums;
        }

        // Cross-reference Jellyfin by artist+title for cases where MBIDs are
        // missing/mismatched (e.g., release MBID vs release-group MBID).
        if (await isJellyfinMusicSource()) {
            const unresolved = albumsWithOwnership.filter((a: any) => !a.owned);
            if (unresolved.length > 0) {
                try {
                    const cfg = await getJellyfinConfig();
                    if (cfg) {
                        const artistAliasesForSearch = getArtistNameAliases(
                            artist.name
                        );
                        const normalizedArtistAliases = new Set(
                            artistAliasesForSearch.map((n) => normalizeArtistName(n))
                        );
                        let jfArtist: { id: string; name: string } | null = null;
                        for (const alias of artistAliasesForSearch) {
                            const { artists: jfArtists } = await getJellyfinArtists(cfg, {
                                search: alias,
                                limit: 25,
                                offset: 0,
                            });
                            jfArtist =
                                jfArtists.find((a) =>
                                    normalizedArtistAliases.has(
                                        normalizeArtistName(a.name)
                                    )
                                ) ?? null;
                            if (jfArtist) break;
                        }

                        if (jfArtist) {
                            const jfAlbums = await getJellyfinAlbumsAllForArtist(
                                cfg,
                                jfArtist.id
                            );
                            const jfRg = new Set(
                                jfAlbums
                                    .map((a) => a.rgMbid)
                                    .filter(Boolean)
                            );
                            const jfTitleKeys = new Set(
                                jfAlbums.map((a) => normalizeAlbumTitle(a.title))
                            );

                            for (const album of albumsWithOwnership as any[]) {
                                if (album.owned) continue;
                                const byRg =
                                    !!album.rgMbid && jfRg.has(album.rgMbid);
                                const byTitle = jfTitleKeys.has(
                                    normalizeAlbumTitle(album.title)
                                );
                                if (byRg || byTitle) {
                                    album.owned = true;
                                }
                            }
                        }

                        // Global title fallback: if artist lookup misses due naming/indexing
                        // differences, still attempt to mark unresolved MB albums as owned by
                        // searching Jellyfin by album title and validating artist alias match.
                        const unresolvedAfterArtistPass = (
                            albumsWithOwnership as any[]
                        ).filter((a) => !a.owned);
                        if (unresolvedAfterArtistPass.length > 0) {
                            const uniqueTitles = Array.from(
                                new Set(
                                    unresolvedAfterArtistPass.map((a) =>
                                        normalizeAlbumTitle(a.title)
                                    )
                                )
                            ).filter(Boolean);
                            for (const normalizedTitle of uniqueTitles.slice(0, 20)) {
                                const { albums: titleMatches } = await getJellyfinAlbums(
                                    cfg,
                                    {
                                        search: normalizedTitle,
                                        limit: 100,
                                        offset: 0,
                                    }
                                );
                                if (titleMatches.length === 0) continue;

                                for (const album of albumsWithOwnership as any[]) {
                                    if (album.owned) continue;
                                    const matched = titleMatches.find((jfa: {
                                        title: string;
                                        artist?: { id: string; name: string };
                                    }) => {
                                        if (
                                            !albumTitlesLikelySame(
                                                jfa.title,
                                                album.title
                                            )
                                        ) {
                                            return false;
                                        }
                                        const jfArtistName = jfa.artist?.name ?? "";
                                        if (!jfArtistName) return true;
                                        return normalizedArtistAliases.has(
                                            normalizeArtistName(jfArtistName)
                                        );
                                    });
                                    if (matched) {
                                        album.owned = true;
                                    }
                                }
                            }
                        }
                    }
                } catch (err: any) {
                    logger.debug(
                        `[Artist] Jellyfin ownership cross-reference failed for "${artist.name}":`,
                        err?.message ?? err
                    );
                }
            }
        }

        // Extract top tracks from library first
        const allTracks = mergedNativeAlbums.flatMap((a) => a.tracks);
        let topTracks = allTracks.slice(0, 10);

        // Get user play counts for all tracks
        const userId = req.user!.id;
        const trackIds = allTracks.map((t) => t.id);
        const userPlays = await prisma.play.groupBy({
            by: ["trackId"],
            where: {
                userId,
                trackId: { in: trackIds },
            },
            _count: {
                id: true,
            },
        });
        const userPlayCounts = new Map(
            userPlays.map((p) => [p.trackId, p._count.id])
        );

        // Fetch Last.fm top tracks (cached for 24 hours)
        const topTracksCacheKey = `top-tracks:${artist.id}`;
        try {
            // Check cache first
            const cachedTopTracks = await redisClient.get(topTracksCacheKey);
            let lastfmTopTracks: any[] = [];

            if (cachedTopTracks && cachedTopTracks !== "NOT_FOUND") {
                lastfmTopTracks = JSON.parse(cachedTopTracks);
                logger.debug(
                    `[Artist] Using cached top tracks (${lastfmTopTracks.length})`
                );
            } else {
                // Cache miss - fetch from Last.fm
                const validMbid =
                    effectiveMbid && !effectiveMbid.startsWith("temp-")
                        ? effectiveMbid
                        : "";
                lastfmTopTracks = await lastFmService.getArtistTopTracks(
                    validMbid,
                    artist.name,
                    10
                );
                // Cache for 24 hours
                await redisClient.setEx(
                    topTracksCacheKey,
                    24 * 60 * 60,
                    JSON.stringify(lastfmTopTracks)
                );
                logger.debug(
                    `[Artist] Cached ${lastfmTopTracks.length} top tracks`
                );
            }

            // Build lookup map for O(1) matching instead of O(n*m)
            const tracksByTitle = new Map<string, (typeof allTracks)[0]>();
            for (const track of allTracks) {
                const key = track.title.toLowerCase();
                if (!tracksByTitle.has(key)) {
                    tracksByTitle.set(key, track);
                }
            }

            // For each Last.fm track, try to match with library track or add as unowned
            const combinedTracks: any[] = [];

            for (const lfmTrack of lastfmTopTracks) {
                // O(1) lookup instead of O(n) find
                const key = lfmTrack.name.toLowerCase();
                const matchedTrack = tracksByTitle.get(key);

                if (matchedTrack) {
                    // Track exists in library - include user play count
                    combinedTracks.push({
                        ...matchedTrack,
                        playCount: lfmTrack.playcount
                            ? parseInt(lfmTrack.playcount)
                            : 0,
                        listeners: lfmTrack.listeners
                            ? parseInt(lfmTrack.listeners)
                            : 0,
                        userPlayCount: userPlayCounts.get(matchedTrack.id) || 0,
                        album: {
                            ...matchedTrack.album,
                            coverArt: matchedTrack.album.coverUrl,
                        },
                    });
                } else {
                    // Track NOT in library - add as preview-only track
                    combinedTracks.push({
                        id: `lastfm-${artist.mbid || artist.name}-${
                            lfmTrack.name
                        }`,
                        title: lfmTrack.name,
                        playCount: lfmTrack.playcount
                            ? parseInt(lfmTrack.playcount)
                            : 0,
                        listeners: lfmTrack.listeners
                            ? parseInt(lfmTrack.listeners)
                            : 0,
                        duration: lfmTrack.duration
                            ? Math.floor(parseInt(lfmTrack.duration) / 1000)
                            : 0,
                        url: lfmTrack.url,
                        album: {
                            title: lfmTrack.album?.["#text"] || "Unknown Album",
                        },
                        userPlayCount: 0,
                        // NO album.id - this indicates track is not in library
                    });
                }
            }

            topTracks = combinedTracks.slice(0, 10);
        } catch (error) {
            logger.error(
                `Failed to get Last.fm top tracks for ${artist.name}:`,
                error
            );
            // If Last.fm fails, add user play counts to library tracks
            topTracks = topTracks.map((t) => ({
                ...t,
                userPlayCount: userPlayCounts.get(t.id) || 0,
                album: {
                    ...t.album,
                    coverArt: t.album.coverUrl,
                },
            }));
        }

        const heroUrl = await dataCacheService.getArtistImage(
            artist.id,
            artist.name,
            effectiveMbid
        );

        let similarArtists: any[] = [];
        const similarCacheKey = `similar-artists:${artist.id}`;

        // Check if artist has pre-enriched similar artists JSON (full Last.fm data)
        const enrichedSimilar = artist.similarArtistsJson as Array<{
            name: string;
            mbid: string | null;
            match: number;
        }> | null;

        if (enrichedSimilar && enrichedSimilar.length > 0) {
            // Use pre-enriched data from database (fast path)
            logger.debug(
                `[Artist] Using ${enrichedSimilar.length} similar artists from enriched JSON`
            );

            // First, batch lookup which similar artists exist in our library
            const similarNames = enrichedSimilar
                .slice(0, 10)
                .map((s) => s.name.toLowerCase());
            const similarMbids = enrichedSimilar
                .slice(0, 10)
                .map((s) => s.mbid)
                .filter(Boolean) as string[];

            // Find library artists matching by name or mbid
            const libraryMatches = await prisma.artist.findMany({
                where: {
                    OR: [
                        { normalizedName: { in: similarNames } },
                        ...(similarMbids.length > 0
                            ? [{ mbid: { in: similarMbids } }]
                            : []),
                    ],
                },
                select: {
                    id: true,
                    name: true,
                    normalizedName: true,
                    mbid: true,
                    heroUrl: true,
                    _count: {
                        select: {
                            albums: {
                                where: {
                                    location: "LIBRARY",
                                    tracks: { some: {} },
                                },
                            },
                        },
                    },
                },
            });

            // Create lookup maps for quick matching
            const libraryByName = new Map(
                libraryMatches.map((a) => [
                    a.normalizedName?.toLowerCase() || a.name.toLowerCase(),
                    a,
                ])
            );
            const libraryByMbid = new Map(
                libraryMatches.filter((a) => a.mbid).map((a) => [a.mbid!, a])
            );

            // Fetch images in parallel from Deezer (cached in Redis)
            const similarWithImages = await Promise.all(
                enrichedSimilar.slice(0, 10).map(async (s) => {
                    // Check if this artist is in our library
                    const libraryArtist =
                        (s.mbid && libraryByMbid.get(s.mbid)) ||
                        libraryByName.get(s.name.toLowerCase());

                    let image = libraryArtist?.heroUrl || null;

                    // If no library image, try Deezer
                    if (!image) {
                        try {
                            // Check Redis cache first
                            const cacheKey = `deezer-artist-image:${s.name}`;
                            const cached = await redisClient.get(cacheKey);
                            if (cached && cached !== "NOT_FOUND") {
                                image = cached;
                            } else {
                                image = await deezerService.getArtistImage(
                                    s.name
                                );
                                if (image) {
                                    await redisClient.setEx(
                                        cacheKey,
                                        24 * 60 * 60,
                                        image
                                    );
                                }
                            }
                        } catch (err) {
                            // Deezer failed, leave null
                        }
                    }

                    return {
                        id: libraryArtist?.id || s.name,
                        name: s.name,
                        mbid: s.mbid || null,
                        coverArt: image,
                        albumCount: 0, // Would require MusicBrainz lookup - skip for performance
                        ownedAlbumCount: libraryArtist?._count?.albums || 0,
                        weight: s.match,
                        inLibrary: !!libraryArtist,
                    };
                })
            );

            similarArtists = similarWithImages;
        } else {
            // No enriched data - fetch from Last.fm API with Redis cache
            const cachedSimilar = await redisClient.get(similarCacheKey);
            if (cachedSimilar && cachedSimilar !== "NOT_FOUND") {
                similarArtists = JSON.parse(cachedSimilar);
                logger.debug(
                    `[Artist] Using cached similar artists (${similarArtists.length})`
                );
            } else {
                // Cache miss - fetch from Last.fm
                logger.debug(
                    `[Artist] Fetching similar artists from Last.fm...`
                );

                try {
                    const validMbid =
                        effectiveMbid && !effectiveMbid.startsWith("temp-")
                            ? effectiveMbid
                            : "";
                    const lastfmSimilar = await lastFmService.getSimilarArtists(
                        validMbid,
                        artist.name,
                        10
                    );

                    // Batch lookup which similar artists exist in our library
                    const similarNames = lastfmSimilar.map((s: any) =>
                        s.name.toLowerCase()
                    );
                    const similarMbids = lastfmSimilar
                        .map((s: any) => s.mbid)
                        .filter(Boolean) as string[];

                    const libraryMatches = await prisma.artist.findMany({
                        where: {
                            OR: [
                                { normalizedName: { in: similarNames } },
                                ...(similarMbids.length > 0
                                    ? [{ mbid: { in: similarMbids } }]
                                    : []),
                            ],
                        },
                        select: {
                            id: true,
                            name: true,
                            normalizedName: true,
                            mbid: true,
                            heroUrl: true,
                            _count: {
                                select: {
                                    albums: {
                                        where: {
                                            location: "LIBRARY",
                                            tracks: { some: {} },
                                        },
                                    },
                                },
                            },
                        },
                    });

                    const libraryByName = new Map(
                        libraryMatches.map((a) => [
                            a.normalizedName?.toLowerCase() ||
                                a.name.toLowerCase(),
                            a,
                        ])
                    );
                    const libraryByMbid = new Map(
                        libraryMatches
                            .filter((a) => a.mbid)
                            .map((a) => [a.mbid!, a])
                    );

                    // Fetch images in parallel (Deezer only - fastest source)
                    const similarWithImages = await Promise.all(
                        lastfmSimilar.map(async (s: any) => {
                            const libraryArtist =
                                (s.mbid && libraryByMbid.get(s.mbid)) ||
                                libraryByName.get(s.name.toLowerCase());

                            let image = libraryArtist?.heroUrl || null;

                            if (!image) {
                                try {
                                    image = await deezerService.getArtistImage(
                                        s.name
                                    );
                                } catch (err) {
                                    // Deezer failed, leave null
                                }
                            }

                            return {
                                id: libraryArtist?.id || s.name,
                                name: s.name,
                                mbid: s.mbid || null,
                                coverArt: image,
                                albumCount: 0,
                                ownedAlbumCount:
                                    libraryArtist?._count?.albums || 0,
                                weight: s.match,
                                inLibrary: !!libraryArtist,
                            };
                        })
                    );

                    similarArtists = similarWithImages;

                    // Cache for 7 days – similar artists rarely change
                    await redisClient.setEx(
                        similarCacheKey,
                        7 * 24 * 60 * 60,
                        JSON.stringify(similarArtists)
                    );
                    logger.debug(
                        `[Artist] Cached ${similarArtists.length} similar artists`
                    );
                } catch (error) {
                    logger.error(
                        `[Artist] Failed to fetch similar artists:`,
                        error
                    );
                    similarArtists = [];
                }
            }
        }

        res.json({
            ...artist,
            coverArt: heroUrl, // Use fetched hero image (falls back to artist.heroUrl)
            bio: getArtistDisplaySummary(artist),
            genres: getMergedGenres(artist),
            albums: albumsWithOwnership,
            appearsOn: appearsOnDbAlbums,
            topTracks,
            similarArtists,
        });
    } catch (error) {
        logger.error("Get artist error:", error);
        res.status(500).json({ error: "Failed to fetch artist" });
    }
});

router.delete("/artists/:id", async (req, res) => {
    try {
        const artist = await prisma.artist.findUnique({
            where: { id: req.params.id },
            include: {
                albums: {
                    include: {
                        tracks: true,
                    },
                },
            },
        });

        if (!artist) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // Delete all track files and collect actual artist folders from file paths
        let deletedFiles = 0;
        const artistFoldersToDelete = new Set<string>();

        for (const album of artist.albums) {
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

                            // Extract actual artist folder from file path
                            // Path format: Soulseek/Artist/Album/Track.mp3 OR Artist/Album/Track.mp3
                            const pathParts = track.filePath.split(path.sep);
                            if (pathParts.length >= 2) {
                                // If first part is "Soulseek", artist folder is Soulseek/Artist
                                // Otherwise, artist folder is just Artist
                                const actualArtistFolder =
                                    pathParts[0].toLowerCase() === "soulseek"
                                        ? path.join(
                                              config.music.musicPath,
                                              pathParts[0],
                                              pathParts[1]
                                          )
                                        : path.join(
                                              config.music.musicPath,
                                              pathParts[0]
                                          );
                                artistFoldersToDelete.add(actualArtistFolder);
                            } else if (pathParts.length === 1) {
                                // Single-level path (rare case)
                                const actualArtistFolder = path.join(
                                    config.music.musicPath,
                                    pathParts[0]
                                );
                                artistFoldersToDelete.add(actualArtistFolder);
                            }
                        }
                    } catch (err) {
                        logger.warn("[DELETE] Could not delete file:", err);
                    }
                }
            }
        }

        // Delete artist folders based on actual file paths, not database name
        for (const artistFolder of artistFoldersToDelete) {
            try {
                if (fs.existsSync(artistFolder)) {
                    logger.debug(
                        `[DELETE] Attempting to delete folder: ${artistFolder}`
                    );

                    // Always try recursive delete with force
                    fs.rmSync(artistFolder, {
                        recursive: true,
                        force: true,
                    });
                    logger.debug(
                        `[DELETE] Successfully deleted artist folder: ${artistFolder}`
                    );
                }
            } catch (err: any) {
                logger.error(
                    `[DELETE] Failed to delete artist folder ${artistFolder}:`,
                    err?.message || err
                );

                // Try alternative: delete contents first, then folder
                try {
                    const files = fs.readdirSync(artistFolder);
                    for (const file of files) {
                        const filePath = path.join(artistFolder, file);
                        try {
                            const stat = fs.statSync(filePath);
                            if (stat.isDirectory()) {
                                fs.rmSync(filePath, {
                                    recursive: true,
                                    force: true,
                                });
                            } else {
                                fs.unlinkSync(filePath);
                            }
                            logger.debug(`[DELETE] Deleted: ${filePath}`);
                        } catch (fileErr: any) {
                            logger.error(
                                `[DELETE] Could not delete ${filePath}:`,
                                fileErr?.message
                            );
                        }
                    }
                    // Try deleting the now-empty folder
                    fs.rmdirSync(artistFolder);
                    logger.debug(
                        `[DELETE] Deleted artist folder after manual cleanup: ${artistFolder}`
                    );
                } catch (cleanupErr: any) {
                    logger.error(
                        `[DELETE] Cleanup also failed for ${artistFolder}:`,
                        cleanupErr?.message
                    );
                }
            }
        }

        // Also try deleting from common music folder paths (in case tracks weren't indexed)
        const commonPaths = [
            path.join(config.music.musicPath, artist.name),
            path.join(config.music.musicPath, "Soulseek", artist.name),
            path.join(config.music.musicPath, "discovery", artist.name),
        ];

        for (const commonPath of commonPaths) {
            if (
                fs.existsSync(commonPath) &&
                !artistFoldersToDelete.has(commonPath)
            ) {
                try {
                    fs.rmSync(commonPath, { recursive: true, force: true });
                    logger.debug(
                        `[DELETE] Deleted additional artist folder: ${commonPath}`
                    );
                } catch (err: any) {
                    logger.error(
                        `[DELETE] Could not delete ${commonPath}:`,
                        err?.message
                    );
                }
            }
        }

        // Delete from Lidarr if connected and artist has MBID
        let lidarrDeleted = false;
        let lidarrError: string | null = null;
        if (artist.mbid && !artist.mbid.startsWith("temp-")) {
            try {
                const { lidarrService } = await import("../../services/lidarr");
                const lidarrResult = await lidarrService.deleteArtist(
                    artist.mbid,
                    true
                );
                if (lidarrResult.success) {
                    logger.debug(`[DELETE] Lidarr: ${lidarrResult.message}`);
                    lidarrDeleted = true;
                } else {
                    logger.warn(
                        `[DELETE] Lidarr deletion note: ${lidarrResult.message}`
                    );
                    lidarrError = lidarrResult.message;
                }
            } catch (err: any) {
                logger.warn(
                    "[DELETE] Could not delete from Lidarr:",
                    err?.message || err
                );
                lidarrError = err?.message || "Unknown error";
            }
        }

        // Explicitly delete OwnedAlbum records first (should cascade, but being safe)
        try {
            await prisma.ownedAlbum.deleteMany({
                where: { artistId: artist.id },
            });
        } catch (err) {
            logger.warn("[DELETE] Could not delete OwnedAlbum records:", err);
        }

        // Delete from database (cascade will delete albums and tracks)
        logger.debug(
            `[DELETE] Deleting artist from database: ${artist.name} (${artist.id})`
        );
        await prisma.artist.delete({
            where: { id: artist.id },
        });

        logger.debug(
            `[DELETE] Successfully deleted artist: ${
                artist.name
            } (${deletedFiles} files${
                lidarrDeleted ? ", removed from Lidarr" : ""
            })`
        );

        res.json({
            message: "Artist deleted successfully",
            deletedFiles,
            lidarrDeleted,
            lidarrError,
        });
    } catch (error: any) {
        logger.error("Delete artist error:", error?.message || error);
        logger.error("Delete artist stack:", error?.stack);
        res.status(500).json({
            error: "Failed to delete artist",
            details: error?.message || "Unknown error",
        });
    }
});

export default router;
