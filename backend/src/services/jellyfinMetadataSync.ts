/**
 * Jellyfin Track Metadata Sync
 *
 * Syncs Jellyfin library into JellyfinTrackMetadata for mood/vibe radio.
 * Also syncs OwnedAlbum records so that Jellyfin albums appear as owned.
 * Run periodically or on-demand. Enrichment (Last.fm tags) is done separately.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import {
    getJellyfinConfig,
    getJellyfinTracksForSync,
    getJellyfinAlbums,
    isJellyfinMusicSource,
} from "./jellyfin";
import { resolveJellyfinArtistToNative } from "./jellyfinArtistBridge";
import { redisClient } from "../utils/redis";

const BATCH_SIZE = 200;
const VARIOUS_ARTISTS_MBID = "89ad4ac3-39f7-470e-963a-56509c546377";

function normalizeTitle(value: string | null | undefined): string {
    return (value ?? "")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isVariousArtistsName(value: string | null | undefined): boolean {
    const normalized = normalizeTitle(value);
    return (
        normalized === "various artists" ||
        normalized === "various artist" ||
        normalized === "various" ||
        normalized === "va"
    );
}

async function ensureCanonicalVariousArtistId(): Promise<string> {
    const existing = await prisma.artist.findUnique({
        where: { mbid: VARIOUS_ARTISTS_MBID },
        select: { id: true },
    });
    if (existing) return existing.id;
    const created = await prisma.artist.create({
        data: {
            mbid: VARIOUS_ARTISTS_MBID,
            name: "Various Artists",
            normalizedName: normalizeTitle("Various Artists"),
            enrichmentStatus: "pending",
        },
        select: { id: true },
    });
    return created.id;
}

export interface SyncResult {
    synced: number;
    removed: number;
    total: number;
    durationMs: number;
}

/**
 * Sync Jellyfin library into JellyfinTrackMetadata.
 * Upserts tracks; removes metadata for tracks no longer in Jellyfin.
 */
export async function syncJellyfinTrackMetadata(): Promise<SyncResult | null> {
    if (!(await isJellyfinMusicSource())) {
        logger.debug("[JellyfinMetadataSync] Skipped \u2013 Jellyfin is not music source");
        return null;
    }

    const cfg = await getJellyfinConfig();
    if (!cfg) {
        logger.warn("[JellyfinMetadataSync] Jellyfin not configured");
        return null;
    }

    const start = Date.now();
    let synced = 0;
    const seenIds = new Set<string>();

    try {
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const { items, total } = await getJellyfinTracksForSync(cfg, {
                limit: BATCH_SIZE,
                offset,
            });

            for (const item of items) {
                seenIds.add(item.jellyfinId);
                await prisma.jellyfinTrackMetadata.upsert({
                    where: { jellyfinId: item.jellyfinId },
                    create: {
                        jellyfinId: item.jellyfinId,
                        artistName: item.artistName,
                        trackTitle: item.trackTitle,
                        albumTitle: item.albumTitle,
                        artistMbid: item.artistMbid,
                        rgMbid: item.rgMbid,
                    },
                    update: {
                        artistName: item.artistName,
                        trackTitle: item.trackTitle,
                        albumTitle: item.albumTitle,
                        artistMbid: item.artistMbid,
                        rgMbid: item.rgMbid,
                        updatedAt: new Date(),
                    },
                });
                synced++;
            }

            offset += items.length;
            hasMore = items.length === BATCH_SIZE && offset < total;

            if (items.length < BATCH_SIZE) break;
        }

        // Remove metadata for tracks no longer in Jellyfin
        const toRemove = await prisma.jellyfinTrackMetadata.findMany({
            where: { jellyfinId: { notIn: Array.from(seenIds) } },
            select: { jellyfinId: true },
        });
        const removed = toRemove.length;
        if (removed > 0) {
            await prisma.jellyfinTrackMetadata.deleteMany({
                where: { jellyfinId: { in: toRemove.map((r) => r.jellyfinId) } },
            });
        }

        const durationMs = Date.now() - start;
        logger.info(
            `[JellyfinMetadataSync] Complete: ${synced} synced, ${removed} removed in ${durationMs}ms`
        );
        return { synced, removed, total: seenIds.size, durationMs };
    } catch (err: any) {
        logger.error("[JellyfinMetadataSync] Failed:", err?.message || err);
        throw err;
    }
}

async function syncCanonicalAlbumArtistCredits(
    canonicalAlbumId: string,
    jellyfinAlbum: {
        title: string;
        artist?: { id: string; name: string };
        albumArtists?: { id: string; name: string }[];
    },
    fallbackPrimaryArtistId?: string | null
): Promise<void> {
    const rawArtists =
        jellyfinAlbum.albumArtists && jellyfinAlbum.albumArtists.length > 0
            ? jellyfinAlbum.albumArtists
            : jellyfinAlbum.artist
              ? [jellyfinAlbum.artist]
              : [];

    if (rawArtists.length === 0 && !fallbackPrimaryArtistId) return;

    const credits: Array<{
        artistId: string | null;
        displayName: string;
        normalizedDisplayName: string;
        role: "PRIMARY" | "COMPILATION";
        sortOrder: number;
        sourceArtistId: string | null;
    }> = [];

    for (let i = 0; i < rawArtists.length; i++) {
        const sourceArtist = rawArtists[i];
        const displayName = sourceArtist.name?.trim() || "Unknown Artist";
        const normalizedDisplayName = normalizeTitle(displayName);

        let artistId: string | null = null;
        if (isVariousArtistsName(displayName)) {
            artistId = await ensureCanonicalVariousArtistId();
        } else {
            const bridged = await resolveJellyfinArtistToNative(displayName, null);
            artistId = bridged?.nativeId ?? null;
        }

        const sourceArtistId = sourceArtist.id.startsWith("jellyfin:")
            ? sourceArtist.id.slice("jellyfin:".length)
            : sourceArtist.id;

        credits.push({
            artistId,
            displayName,
            normalizedDisplayName,
            role: isVariousArtistsName(displayName) ? "COMPILATION" : "PRIMARY",
            sortOrder: i,
            sourceArtistId: sourceArtistId || null,
        });
    }

    if (credits.length === 0 && fallbackPrimaryArtistId) {
        const fallbackArtist = await prisma.artist.findUnique({
            where: { id: fallbackPrimaryArtistId },
            select: { id: true, name: true },
        });
        if (fallbackArtist) {
            credits.push({
                artistId: fallbackArtist.id,
                displayName: fallbackArtist.name,
                normalizedDisplayName: normalizeTitle(fallbackArtist.name),
                role: "PRIMARY",
                sortOrder: 0,
                sourceArtistId: null,
            });
        }
    }

    if (credits.length === 0) return;

    const uniqueArtistKeys = new Set(
        credits.map((c) => c.normalizedDisplayName).filter(Boolean)
    );
    const hasVariousArtists = credits.some((c) =>
        isVariousArtistsName(c.displayName)
    );
    const isCompilation = hasVariousArtists || uniqueArtistKeys.size > 1;

    await prisma.$transaction([
        prisma.albumArtistCredit.deleteMany({
            where: { albumId: canonicalAlbumId, source: "JELLYFIN" },
        }),
        prisma.albumArtistCredit.createMany({
            data: credits.map((credit) => ({
                albumId: canonicalAlbumId,
                artistId: credit.artistId,
                displayName: credit.displayName,
                normalizedDisplayName: credit.normalizedDisplayName,
                role: credit.role,
                sortOrder: credit.sortOrder,
                source: "JELLYFIN",
                sourceArtistId: credit.sourceArtistId,
                confidence: 0.95,
                evidence: {
                    jellyfinAlbumTitle: jellyfinAlbum.title,
                },
            })),
        }),
        prisma.album.update({
            where: { id: canonicalAlbumId },
            data: { isCompilation },
        }),
    ]);
}

/**
 * Sync OwnedAlbum records for all albums currently in the Jellyfin library.
 *
 * Albums managed by Lidarr/Jellyfin never go through the native MusicScanner,
 * so OwnedAlbum records are never created via that path. This function fills
 * that gap by iterating all Jellyfin albums, resolving each artist to a native
 * Artist record, and upserting OwnedAlbum for every album that has an rgMbid.
 *
 * Albums without an rgMbid in Jellyfin's ProviderIds (missing MusicBrainz tags)
 * are skipped \u2014 the fallback in /library/albums/:id handles those by checking
 * Jellyfin directly at request time.
 */
export async function syncJellyfinOwnedAlbums(): Promise<{
    processed: number;
    created: number;
    skipped: number;
}> {
    if (!(await isJellyfinMusicSource())) return { processed: 0, created: 0, skipped: 0 };

    const cfg = await getJellyfinConfig();
    if (!cfg) return { processed: 0, created: 0, skipped: 0 };

    let processed = 0;
    let created = 0;
    let skipped = 0;
    let offset = 0;
    const validLegacyArtistIds = new Set<string>();
    const missingLegacyArtistIds = new Set<string>();

    logger.debug("[JellyfinOwnedSync] Starting OwnedAlbum sync from Jellyfin...");

    try {
        while (true) {
            const { albums, total } = await getJellyfinAlbums(cfg, {
                limit: 100,
                offset,
            });

            if (albums.length === 0) break;

            for (const album of albums) {
                processed++;

                const artistName = album.artist?.name;
                if (!artistName && !album.rgMbid) {
                    skipped++;
                    continue;
                }

                try {
                    const bridged = artistName
                        ? await resolveJellyfinArtistToNative(artistName, null)
                        : null;
                    if (!bridged && !album.rgMbid) {
                        skipped++;
                        continue;
                    }

                    const rawJfId = album.id.startsWith("jellyfin:")
                        ? album.id.slice("jellyfin:".length)
                        : album.id;

                    // Resolve canonical album for source mapping + ownership facts.
                    let canonicalAlbum = null as
                        | {
                              id: string;
                              rgMbid: string;
                              title: string;
                              artistId: string;
                          }
                        | null;
                    if (album.rgMbid) {
                        canonicalAlbum = await prisma.album.findUnique({
                            where: { rgMbid: album.rgMbid },
                            select: {
                                id: true,
                                rgMbid: true,
                                title: true,
                                artistId: true,
                            },
                        });
                    }
                    if (!canonicalAlbum) {
                        if (bridged?.nativeId) {
                            const exactTitle = await prisma.album.findFirst({
                                where: {
                                    artistId: bridged.nativeId,
                                    title: { equals: album.title, mode: "insensitive" },
                                },
                                select: {
                                    id: true,
                                    rgMbid: true,
                                    title: true,
                                    artistId: true,
                                },
                            });
                            canonicalAlbum = exactTitle;
                        }
                    }
                    if (!canonicalAlbum) {
                        if (bridged?.nativeId) {
                            const normalizedTarget = normalizeTitle(album.title);
                            const titleCandidates = await prisma.album.findMany({
                                where: { artistId: bridged.nativeId },
                                select: {
                                    id: true,
                                    rgMbid: true,
                                    title: true,
                                    artistId: true,
                                },
                                take: 50,
                            });
                            canonicalAlbum =
                                titleCandidates.find(
                                    (c) => normalizeTitle(c.title) === normalizedTarget
                                ) ?? null;
                        }
                    }

                    const matchMethod =
                        album.rgMbid &&
                        canonicalAlbum?.rgMbid &&
                        album.rgMbid === canonicalAlbum.rgMbid
                            ? "RGMBID"
                            : "TITLE_ARTIST_NORMALIZED";

                    if (canonicalAlbum) {
                        await prisma.albumSourceMap.upsert({
                            where: {
                                source_sourceAlbumId: {
                                    source: "JELLYFIN",
                                    sourceAlbumId: rawJfId,
                                },
                            },
                            create: {
                                source: "JELLYFIN",
                                sourceAlbumId: rawJfId,
                                albumId: canonicalAlbum.id,
                                confidence: matchMethod === "RGMBID" ? 1.0 : 0.92,
                                matchMethod,
                                evidence: {
                                    jellyfinTitle: album.title,
                                    jellyfinArtist: artistName,
                                    jellyfinRgMbid: album.rgMbid ?? null,
                                },
                            },
                            update: {
                                albumId: canonicalAlbum.id,
                                confidence: matchMethod === "RGMBID" ? 1.0 : 0.92,
                                matchMethod,
                                evidence: {
                                    jellyfinTitle: album.title,
                                    jellyfinArtist: artistName,
                                    jellyfinRgMbid: album.rgMbid ?? null,
                                },
                            },
                        });

                        await prisma.albumOwnershipFact.upsert({
                            where: {
                                albumId_source: {
                                    albumId: canonicalAlbum.id,
                                    source: "JELLYFIN",
                                },
                            },
                            create: {
                                albumId: canonicalAlbum.id,
                                source: "JELLYFIN",
                                sourceAlbumId: rawJfId,
                                status: "OWNED",
                                matchMethod,
                                confidence: matchMethod === "RGMBID" ? 1.0 : 0.92,
                                evidence: {
                                    jellyfinTitle: album.title,
                                    jellyfinArtist: artistName,
                                    jellyfinRgMbid: album.rgMbid ?? null,
                                },
                            },
                            update: {
                                sourceAlbumId: rawJfId,
                                status: "OWNED",
                                matchMethod,
                                confidence: matchMethod === "RGMBID" ? 1.0 : 0.92,
                                observedAt: new Date(),
                                evidence: {
                                    jellyfinTitle: album.title,
                                    jellyfinArtist: artistName,
                                    jellyfinRgMbid: album.rgMbid ?? null,
                                },
                            },
                        });

                        await syncCanonicalAlbumArtistCredits(
                            canonicalAlbum.id,
                            {
                                title: album.title,
                                artist: album.artist,
                                albumArtists: album.albumArtists,
                            },
                            bridged?.nativeId ?? null
                        );
                    }

                    // Keep legacy OwnedAlbum path for compatibility while read paths migrate.
                    if (album.rgMbid && bridged?.nativeId) {
                        let canWriteLegacy = validLegacyArtistIds.has(
                            bridged.nativeId
                        );
                        if (
                            !canWriteLegacy &&
                            !missingLegacyArtistIds.has(bridged.nativeId)
                        ) {
                            const artistExists = await prisma.artist.findUnique({
                                where: { id: bridged.nativeId },
                                select: { id: true },
                            });
                            if (artistExists) {
                                validLegacyArtistIds.add(bridged.nativeId);
                                canWriteLegacy = true;
                            } else {
                                missingLegacyArtistIds.add(bridged.nativeId);
                            }
                        }

                        if (canWriteLegacy) {
                            try {
                                await prisma.ownedAlbum.upsert({
                                    where: {
                                        artistId_rgMbid: {
                                            artistId: bridged.nativeId,
                                            rgMbid: album.rgMbid,
                                        },
                                    },
                                    create: {
                                        artistId: bridged.nativeId,
                                        rgMbid: album.rgMbid,
                                        source: "jellyfin_sync",
                                    },
                                    update: {},
                                });
                                created++;
                            } catch (err: any) {
                                // If artist row vanished between exists-check and upsert,
                                // mark this artistId as missing and avoid repeated FK spam.
                                if (err?.code === "P2003") {
                                    validLegacyArtistIds.delete(bridged.nativeId);
                                    missingLegacyArtistIds.add(bridged.nativeId);
                                } else {
                                    throw err;
                                }
                            }
                        }
                    }

                    // Cache rgMbid → Jellyfin ID so album detail pages can do a
                    // single direct lookup instead of scanning the whole library.
                    if (redisClient.isReady) {
                        if (album.rgMbid) {
                            await redisClient
                                .setEx(`jf:rgmbid:${album.rgMbid}`, 30 * 24 * 3600, rawJfId)
                                .catch(() => {});
                        }
                    }
                } catch (err: any) {
                    logger.debug(
                        `[JellyfinOwnedSync] Failed for album "${album.title}" by "${artistName}":`,
                        err?.message
                    );
                    skipped++;
                }
            }

            offset += albums.length;
            if (offset >= total || albums.length < 100) break;
        }

        logger.info(
            `[JellyfinOwnedSync] Done: ${processed} albums, ${created} OwnedAlbum records upserted, ${skipped} skipped`
        );
    } catch (err: any) {
        logger.error("[JellyfinOwnedSync] Failed:", err?.message || err);
    }

    return { processed, created, skipped };
}
