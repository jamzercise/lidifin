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

const BATCH_SIZE = 200;

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

                if (!album.rgMbid) {
                    skipped++;
                    continue;
                }

                const artistName = album.artist?.name;
                if (!artistName) {
                    skipped++;
                    continue;
                }

                try {
                    const bridged = await resolveJellyfinArtistToNative(artistName, null);
                    if (!bridged) {
                        skipped++;
                        continue;
                    }

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
