import { Router } from "express";
import { logger, JELLYFIN_UNREACHABLE_MESSAGE, ARTIST_SORT_MAP, MAX_LIMIT } from "./_helpers";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { config } from "../../config";
import path from "path";
import fs from "fs";
import { lastFmService } from "../../services/lastfm";
import { deezerService } from "../../services/deezer";
import { dataCacheService } from "../../services/dataCache";
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
import {
    collectJellyfinAlbumsForArtistAliases,
    popularTracksPreferLibrary,
    topTracksFromJellyfin,
    transformJellyfinAlbums,
} from "./artistDetailHelpers";
import { pickSavedRgMbids } from "../../services/savedDiscoveryAlbumService";

const router = Router();

/**
 * @openapi
 * /library/artists:
 *   get:
 *     summary: List library artists
 *     description: Mobile-supported artist listing endpoint. Returns paginated artists from Prisma or Jellyfin depending on the active music source.
 *     tags: [Library]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *       - sessionAuth: []
 *     parameters:
 *       - in: query
 *         name: query
 *         schema:
 *           type: string
 *         description: Optional case-insensitive artist search
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Optional cursor for cursor-based pagination
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *           enum: [owned, discovery, all]
 *           default: owned
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           default: name
 *     responses:
 *       200:
 *         description: Artists returned successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       mbid:
 *                         type: string
 *                         nullable: true
 *                       heroUrl:
 *                         type: string
 *                         nullable: true
 *                       coverArt:
 *                         type: string
 *                         nullable: true
 *                       albumCount:
 *                         type: integer
 *                       trackCount:
 *                         type: integer
 *                 total:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       503:
 *         description: Upstream Jellyfin unavailable
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
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

        // Non-Jellyfin: artists with at least one album that has tracks.
        // `filter=discovery` is a no-op (returns empty) for URL compatibility.
        const orderBy = ARTIST_SORT_MAP[sortBy as string] ?? { name: "asc" as const };

        if (filter === "discovery") {
            return res.json({
                artists: [],
                total: 0,
                offset,
                limit,
                nextCursor: null,
            });
        }

        const where: any = {
            albums: { some: { tracks: { some: {} } } },
        };
        if (query) {
            where.name = { contains: query as string, mode: "insensitive" };
        }

        const [artists, total] = await prisma.$transaction(
            async (tx) => {
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
                        _count: {
                            select: {
                                albums: { where: { tracks: { some: {} } } },
                            },
                        },
                    },
                };

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
            { timeout: 30000 }
        );

        type ArtistRowWithCount = (typeof artists)[number] & {
            _count: { albums: number };
        };
        const artistsWithCount = artists as ArtistRowWithCount[];

        const imageMap = await dataCacheService.getArtistImagesBatch(
            artistsWithCount.map((a) => ({
                id: a.id,
                heroUrl: a.heroUrl,
                userHeroUrl: a.userHeroUrl,
            }))
        );

        const artistsWithImages = artistsWithCount.map((artist) => {
            const coverArt =
                imageMap.get(artist.id) || artist.heroUrl || null;

            return {
                id: artist.id,
                mbid: artist.mbid,
                name: artist.name,
                heroUrl: coverArt,
                coverArt,
                albumCount: artist._count.albums,
                trackCount: 0,
            };
        });

        const nextCursor =
            artistsWithCount.length === limit
                ? artistsWithCount[artistsWithCount.length - 1].id
                : null;

        res.json({
            artists: artistsWithImages,
            total,
            offset,
            limit,
            nextCursor,
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

// Arch-X.d removed the denormalized artist-count columns
// (`libraryAlbumCount`, `discoveryAlbumCount`, `totalTrackCount`,
// `countsLastUpdated`) and the artistCountsService that backfilled
// them. The /artist-counts/status and /artist-counts/backfill admin
// endpoints are retained as no-op stubs so any UI/curl bookmarks don't
// 404; they always report "no backfill needed".
router.get("/artist-counts/status", async (_req, res) => {
    res.json({
        needsBackfill: false,
        processed: 0,
        total: 0,
        percent: 100,
        isRunning: false,
        errors: 0,
    });
});

router.post("/artist-counts/backfill", async (_req, res) => {
    res.json({
        message: "Artist counts removed in Arch-X.d; nothing to backfill",
        status: "idle",
    });
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
//
// Phase-2 metadata for the artist page. Returns the heavy / external-data
// fields (bio, similarArtists, discoveryAlbums, image fallbacks) so the main
// /:id endpoint can stay snappy and Jellyfin-only.
//
// Note: This endpoint deliberately does NOT return `topTracks` anymore. The
// main /:id endpoint owns top-track resolution since X.a.1, where it can
// match Last.fm titles against the user's Jellyfin tracks and emit the
// correct `jellyfin:UUID` ids that make tracks playable. Returning Last.fm
// shapes here would override that in the frontend's two-phase merge and
// re-introduce the PREVIEW-tag bug.
router.get("/artists/:id/enrichment", async (req, res) => {
    try {
        const userId = req.user!.id;
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
        const rawName = (artistItem as any).Name ?? (artistItem as any).name;
        const tentativeName: string =
            rawName && rawName !== artistItem.Id && !rawName.startsWith("jellyfin:")
                ? rawName
                : decodeURIComponent(idParam);
        // Use the alias-sibling recovery here too, so the rgMbid set we use
        // to filter discovery candidates reflects ALL of the user's owned
        // copies — not just the primary artist record's relation. Otherwise
        // an album owned under "Hold Steady" gets re-suggested as discovery
        // when the user is viewing "The Hold Steady".
        const albums = await collectJellyfinAlbumsForArtistAliases(
            cfg,
            resolvedId,
            getArtistNameAliases(tentativeName),
            {
                getAlbumsForArtist: getJellyfinAlbumsAllForArtist,
                searchArtists: (config, opts) => getJellyfinArtists(config, opts),
            }
        );
        const artistName =
            tentativeName !== decodeURIComponent(idParam)
                ? tentativeName
                : albums[0]?.artist?.name ?? tentativeName;
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
                savedRgMbids: [],
            });
        }

        // Filter out anything the user already owns. Title fallback handles
        // the (common) case where Jellyfin albums lack rgMbid tags entirely
        // — without it we'd happily list "Stay Positive" as a discovery
        // suggestion despite the user owning it.
        const ownedRgMbids = new Set(
            albums.map((a) => a.rgMbid).filter(Boolean) as string[]
        );
        const ownedTitleKeys = new Set(
            albums
                .map((a) => a.title?.toLowerCase().trim())
                .filter(Boolean) as string[]
        );
        const discoveryAlbums = enrichment.discoveryAlbums
            .filter((d) => {
                if (ownedRgMbids.has(d.rgMbid)) return false;
                const titleKey = d.title?.toLowerCase().trim();
                if (titleKey && ownedTitleKeys.has(titleKey)) return false;
                return true;
            })
            .map((d) => ({
                id: d.id,
                title: d.title,
                // Preserve MB primary-type ("Album" / "EP" / etc.) so the
                // frontend can split studio albums from EPs/singles correctly.
                type: d.type ?? null,
                coverArt: d.coverUrl,
                coverUrl: d.coverUrl,
                artist: { name: artistName },
                year: d.year,
                rgMbid: d.rgMbid,
                owned: false,
                source: "musicbrainz" as const,
                tracks: [],
            }));

        const discoveryRgMbids = discoveryAlbums
            .map((d) => d.rgMbid)
            .filter((x): x is string => typeof x === "string" && x.length > 0);
        const savedRgMbids = Array.from(
            await pickSavedRgMbids(userId, discoveryRgMbids)
        );

        return res.json({
            bio: enrichment.bio,
            image: enrichment.image ?? coverArt ?? null,
            genres: enrichment.genres ?? [],
            listeners: enrichment.listeners,
            playcount: enrichment.playcount,
            similarArtists: enrichment.similarArtists ?? [],
            discoveryAlbums,
            savedRgMbids,
        });
    } catch (err: any) {
        logger.error("[Library] Artist enrichment error:", err);
        res.status(500).json({ error: err.message ?? "Enrichment failed" });
    }
});

// GET /library/artists/:id
//
// Jellyfin-first artist detail. Lidifin treats Jellyfin as the sole content
// source; the Prisma `Artist` row is a metadata cache (bio, similar artists,
// user overrides), not a content owner. The handler:
//
//  1. Resolves the artist in Jellyfin by `jellyfin:UUID` or by name (with
//     "The Books" / "Books, The" alias variants).
//  2. Fetches Jellyfin albums + tracks plus the Prisma cache row in parallel.
//  3. Matches Last.fm top tracks against the user's Jellyfin tracks so
//     popular songs return playable `jellyfin:UUID` ids (no PREVIEW tags
//     for owned content). This is the central fix from the X.a.1 refactor.
//  4. Defers discovery albums (MusicBrainz release groups not in Jellyfin)
//     to the phase-2 enrichment endpoint, which the frontend merges in.
//
// Removed in X.a.1: long Prisma-first path and legacy mirror reconciliation (X.d dropped those tables).
router.get("/artists/:id", async (req, res) => {
    try {
        const idParam = decodeURIComponent(req.params.id);
        const userId = req.user!.id;

        // Local-files mode is deprecated. Routes only serve Jellyfin content.
        if (!(await isJellyfinMusicSource())) {
            return res.status(404).json({ error: "Artist not found" });
        }
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

        // Resolve in Jellyfin: by jellyfin:UUID first, otherwise by name with
        // alias variants ("The Books" ↔ "Books, The").
        const aliases = getArtistNameAliases(idParam);
        let artistItem: Awaited<ReturnType<typeof getJellyfinArtistByName>> = null;
        if (idParam.startsWith("jellyfin:")) {
            const rawId = idParam.slice("jellyfin:".length);
            const item = await getJellyfinItem(cfg, rawId);
            if (item?.Type === "MusicArtist") artistItem = item;
        }
        if (!artistItem) {
            for (const alias of aliases) {
                artistItem = await getJellyfinArtistByName(cfg, alias);
                if (artistItem) break;
            }
        }
        if (!artistItem || artistItem.Type !== "MusicArtist") {
            return res.status(404).json({ error: "Artist not found" });
        }

        const jfArtistId = `jellyfin:${artistItem.Id}`;
        const rawName = (artistItem as any).Name ?? (artistItem as any).name;
        const artistName: string =
            rawName && rawName !== artistItem.Id && !rawName.startsWith("jellyfin:")
                ? rawName
                : aliases[0] ?? "Unknown Artist";
        const jfMbid =
            extractArtistMbid((artistItem as any).ProviderIds) ?? null;
        const jellyfinCoverArt = artistItem.ImageTags?.Primary
            ? getJellyfinImageUrl(
                  cfg.url,
                  artistItem.Id,
                  artistItem.ImageTags.Primary,
                  cfg.apiKey,
                  cfg.userId
              ) ?? null
            : null;

        // Parallel: Jellyfin albums (with alias-sibling recovery for
        // metadata splits — see X.a.1.1), Jellyfin tracks, and the Prisma
        // metadata-cache row (best-effort; absent rows are fine).
        const normalizedAliases = Array.from(
            new Set(aliases.map((a) => normalizeArtistName(a)).filter(Boolean))
        );
        const [jfAlbums, jfTracksResult, prismaArtist] = await Promise.all([
            collectJellyfinAlbumsForArtistAliases(cfg, jfArtistId, aliases, {
                getAlbumsForArtist: getJellyfinAlbumsAllForArtist,
                searchArtists: (config, opts) =>
                    getJellyfinArtists(config, opts),
            }),
            getJellyfinTracks(cfg, { artistId: jfArtistId, limit: 500 }).catch(
                () => ({ tracks: [], total: 0 })
            ),
            prisma.artist
                .findFirst({
                    where: {
                        OR: [
                            ...(jfMbid ? [{ mbid: jfMbid }] : []),
                            ...(normalizedAliases.length > 0
                                ? [{ normalizedName: { in: normalizedAliases } }]
                                : []),
                            { id: idParam },
                        ],
                    },
                })
                .catch((err) => {
                    logger.warn(
                        `[Artist] Prisma cache lookup failed for ${artistName}:`,
                        err?.message ?? err
                    );
                    return null;
                }),
        ]);

        const jellyfinTracks = jfTracksResult.tracks;
        const albums = transformJellyfinAlbums(jfAlbums, {
            id: jfArtistId,
            name: artistName,
        });

        // Use the cleaner of (Jellyfin's MBID, Prisma's MBID); ignore temp-
        // synthetic MBIDs that pre-X.d Prisma rows can carry.
        const cleanPrismaMbid =
            prismaArtist?.mbid && !prismaArtist.mbid.startsWith("temp-")
                ? prismaArtist.mbid
                : null;
        const effectiveMbid = jfMbid || cleanPrismaMbid;

        // User play counts. Play.trackId stores either a Prisma cuid or
        // jellyfin:UUID (no FK; resolved at read time).
        const trackIds = jellyfinTracks.map((t) => t.id);
        const userPlays =
            trackIds.length > 0
                ? await prisma.play.groupBy({
                      by: ["trackId"],
                      where: { userId, trackId: { in: trackIds } },
                      _count: { id: true },
                  })
                : [];
        const userPlayCounts = new Map(
            userPlays.map((p) => [p.trackId, p._count.id])
        );

        // Last.fm top tracks (24h Redis cache), matched against Jellyfin
        // titles. Owned matches return `jellyfin:UUID` ids so the frontend
        // shows them as playable; unmatched tracks become PREVIEW shapes.
        const cacheKeyArtistId = prismaArtist?.id ?? jfArtistId;
        const topTracksCacheKey = `top-tracks:${cacheKeyArtistId}:lf20`;
        let topTracks;
        try {
            let lastfmTopTracks: any[] = [];
            const cached = await redisClient.get(topTracksCacheKey);
            if (cached && cached !== "NOT_FOUND") {
                lastfmTopTracks = JSON.parse(cached);
            } else {
                lastfmTopTracks = await lastFmService.getArtistTopTracks(
                    effectiveMbid ?? "",
                    artistName,
                    20
                );
                await redisClient.setEx(
                    topTracksCacheKey,
                    24 * 60 * 60,
                    JSON.stringify(lastfmTopTracks ?? [])
                );
            }
            topTracks = popularTracksPreferLibrary(
                Array.isArray(lastfmTopTracks) ? lastfmTopTracks : [],
                jellyfinTracks,
                userPlayCounts,
                effectiveMbid || artistName,
                { lastfmLimit: 20, outputTarget: 10 }
            );
            // If Last.fm returned nothing usable, fall back to library tracks.
            if (topTracks.length === 0) {
                topTracks = topTracksFromJellyfin(jellyfinTracks, userPlayCounts);
            }
        } catch (err) {
            logger.error(
                `[Artist] Last.fm top tracks failed for ${artistName}:`,
                err
            );
            topTracks = topTracksFromJellyfin(jellyfinTracks, userPlayCounts);
        }

        // Hero image: prefer the Prisma cache (which honors user overrides
        // and stitches Fanart/Deezer/Last.fm) when a row exists; fall back
        // to Jellyfin's primary image.
        let heroUrl: string | null = jellyfinCoverArt;
        if (prismaArtist) {
            const cached = await dataCacheService.getArtistImage(
                prismaArtist.id,
                artistName,
                effectiveMbid || undefined
            );
            if (cached) heroUrl = cached;
        }

        // Similar artists. Two tiers — pre-enriched JSON cache on the
        // Prisma row (fast path) → Last.fm + Redis cache (cold path).
        const similarArtists = await loadSimilarArtists({
            prismaArtist,
            artistName,
            effectiveMbid,
        });

        // User-override fields the frontend's metadata-display layer reads
        // (displayName / userSummary / userHeroUrl / userGenres /
        // hasUserOverrides / summary). Sourced from the Prisma cache row
        // when present; nullish defaults otherwise.
        const overrideFields = prismaArtist
            ? {
                  displayName: prismaArtist.displayName ?? null,
                  userSummary: prismaArtist.userSummary ?? null,
                  userHeroUrl: prismaArtist.userHeroUrl ?? null,
                  userGenres: prismaArtist.userGenres ?? [],
                  hasUserOverrides: prismaArtist.hasUserOverrides ?? false,
                  summary: prismaArtist.summary ?? null,
              }
            : {
                  displayName: null,
                  userSummary: null,
                  userHeroUrl: null,
                  userGenres: [],
                  hasUserOverrides: false,
                  summary: null,
              };

        return res.json({
            id: jfArtistId,
            name: artistName,
            mbid: effectiveMbid,
            normalizedName: normalizeArtistName(artistName),
            coverArt: heroUrl,
            heroUrl,
            image: heroUrl,
            bio: prismaArtist ? getArtistDisplaySummary(prismaArtist) : null,
            genres: prismaArtist ? getMergedGenres(prismaArtist) : [],
            ...overrideFields,
            listeners: undefined,
            playcount: undefined,
            albums,
            appearsOn: [],
            topTracks,
            similarArtists,
        });
    } catch (error) {
        logger.error("Get artist error:", error);
        res.status(500).json({ error: "Failed to fetch artist" });
    }
});

// Helper: load the artist's similar-artists list. Prefers the pre-enriched
// JSON cache on the Prisma row (fast path) and falls back to Last.fm with a
// 7-day Redis cache. Library-membership lookups annotate `inLibrary` and
// surface owned-album counts for the UI's "in your library" badge.
async function loadSimilarArtists(opts: {
    prismaArtist: { id: string; similarArtistsJson?: unknown } | null;
    artistName: string;
    effectiveMbid: string | null;
}): Promise<any[]> {
    const { prismaArtist, artistName, effectiveMbid } = opts;
    const enriched = prismaArtist?.similarArtistsJson as Array<{
        name: string;
        mbid: string | null;
        match: number;
    }> | undefined | null;

    const annotateAndImageify = async (
        list: Array<{ name: string; mbid: string | null; weight: number }>
    ) => {
        const names = list.map((s) => s.name.toLowerCase());
        const mbids = list.map((s) => s.mbid).filter(Boolean) as string[];
        const matches = await prisma.artist.findMany({
            where: {
                OR: [
                    { normalizedName: { in: names } },
                    ...(mbids.length > 0 ? [{ mbid: { in: mbids } }] : []),
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
                        albums: { where: { tracks: { some: {} } } },
                    },
                },
            },
        });
        const byName = new Map(
            matches.map((a) => [
                a.normalizedName?.toLowerCase() || a.name.toLowerCase(),
                a,
            ])
        );
        const byMbid = new Map(
            matches.filter((a) => a.mbid).map((a) => [a.mbid!, a])
        );
        return Promise.all(
            list.map(async (s) => {
                const libraryArtist =
                    (s.mbid && byMbid.get(s.mbid)) ||
                    byName.get(s.name.toLowerCase());
                let image = libraryArtist?.heroUrl ?? null;
                if (!image) {
                    const cacheKey = `deezer-artist-image:${s.name}`;
                    try {
                        const cached = await redisClient.get(cacheKey);
                        if (cached && cached !== "NOT_FOUND") {
                            image = cached;
                        } else {
                            image = await deezerService.getArtistImage(s.name);
                            if (image) {
                                await redisClient.setEx(
                                    cacheKey,
                                    24 * 60 * 60,
                                    image
                                );
                            }
                        }
                    } catch {
                        // Deezer/Redis miss; leave null.
                    }
                }
                return {
                    id: libraryArtist?.id || s.name,
                    name: s.name,
                    mbid: s.mbid || null,
                    coverArt: image,
                    albumCount: 0,
                    ownedAlbumCount: libraryArtist?._count?.albums ?? 0,
                    weight: s.weight,
                    inLibrary: !!libraryArtist,
                };
            })
        );
    };

    if (Array.isArray(enriched) && enriched.length > 0) {
        return annotateAndImageify(
            enriched.slice(0, 10).map((s) => ({
                name: s.name,
                mbid: s.mbid ?? null,
                weight: s.match,
            }))
        );
    }

    const cacheKey = `similar-artists:${prismaArtist?.id ?? artistName}`;
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached && cached !== "NOT_FOUND") {
            return JSON.parse(cached);
        }
        const lastfmSimilar = await lastFmService.getSimilarArtists(
            effectiveMbid ?? "",
            artistName,
            10
        );
        const list = (Array.isArray(lastfmSimilar) ? lastfmSimilar : []).map(
            (s: any) => ({
                name: s.name,
                mbid: s.mbid ?? null,
                weight: s.match,
            })
        );
        const result = await annotateAndImageify(list);
        await redisClient.setEx(
            cacheKey,
            7 * 24 * 60 * 60,
            JSON.stringify(result)
        );
        return result;
    } catch (err) {
        logger.error(`[Artist] Failed to fetch similar artists:`, err);
        return [];
    }
}

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
