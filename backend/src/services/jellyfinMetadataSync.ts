/**
 * Jellyfin Track Metadata Sync
 *
 * Maintains two read-side caches that the Jellyfin-first route handlers
 * (Arch-X.a) rely on:
 *   1. `JellyfinTrackMetadata` — per-track artist / title / mbid
 *      snapshot used by mood/vibe/genre radio. Without this table, every
 *      mood/vibe lookup would hit Jellyfin's REST API.
 *   2. `jf:rgmbid:<MB release-group MBID> -> <jellyfin item id>` Redis
 *      keys — used by `GET /library/albums/:id` to translate a
 *      MusicBrainz id into a Jellyfin id with a single point lookup
 *      instead of a bounded scan over the whole library.
 *
 * Historical: before Arch-X.d this module also mirrored ownership into Prisma.
 * Those writers are gone; ownership is read from Jellyfin at request time.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import {
    getJellyfinConfig,
    getJellyfinTracksForSync,
    getJellyfinAlbums,
    isJellyfinMusicSource,
} from "./jellyfin";
import { redisClient } from "../utils/redis";

const BATCH_SIZE = 200;
const RGMBID_CACHE_TTL_SECONDS = 30 * 24 * 3600;

export interface SyncResult {
    synced: number;
    removed: number;
    total: number;
    durationMs: number;
}

/**
 * Refresh metadata for the most recently added Jellyfin tracks.
 *
 * A full sync walks the entire library and runs on a six-hour timer, which is
 * far too slow for a track that was just downloaded: playlist imports match
 * against this table, so until the new track is in it the import treats it as
 * missing. This tops up the newest entries only, and unlike the full sync it
 * never deletes, so it is safe to run right after a download.
 */
export async function syncRecentJellyfinTracks(
    limit = BATCH_SIZE
): Promise<{ synced: number } | null> {
    if (!(await isJellyfinMusicSource())) return null;

    const cfg = await getJellyfinConfig();
    if (!cfg) return null;

    try {
        const { items } = await getJellyfinTracksForSync(cfg, {
            limit,
            newestFirst: true,
        });

        for (const item of items) {
            await prisma.jellyfinTrackMetadata.upsert({
                where: { jellyfinId: item.jellyfinId },
                create: {
                    jellyfinId: item.jellyfinId,
                    artistName: item.artistName,
                    trackArtists: item.trackArtists,
                    trackTitle: item.trackTitle,
                    albumTitle: item.albumTitle,
                    artistMbid: item.artistMbid,
                    rgMbid: item.rgMbid,
                },
                update: {
                    artistName: item.artistName,
                    trackArtists: item.trackArtists,
                    trackTitle: item.trackTitle,
                    albumTitle: item.albumTitle,
                    artistMbid: item.artistMbid,
                    rgMbid: item.rgMbid,
                    updatedAt: new Date(),
                },
            });
        }

        logger.debug(
            `[JellyfinMetadataSync] Refreshed ${items.length} recently added track(s)`
        );
        return { synced: items.length };
    } catch (err: any) {
        logger.warn(
            "[JellyfinMetadataSync] Recent-track refresh failed:",
            err?.message || err
        );
        return null;
    }
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
                        trackArtists: item.trackArtists,
                        trackTitle: item.trackTitle,
                        albumTitle: item.albumTitle,
                        artistMbid: item.artistMbid,
                        rgMbid: item.rgMbid,
                    },
                    update: {
                        artistName: item.artistName,
                        trackArtists: item.trackArtists,
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
 * Refresh the `jf:rgmbid:<rgMbid>` -> `<jellyfin item id>` Redis cache.
 *
 * Read by `GET /library/albums/:id` (Arch-X.a.2) so that an MBID-only
 * lookup can resolve to a Jellyfin id with a single GET instead of
 * scanning the whole library. Iterates Jellyfin albums in pages and
 * sets a key per album that has an `rgMbid` ProviderId. Albums missing
 * an rgMbid in Jellyfin are skipped — MBID URLs 404 until metadata provides
 * an id (or the user opens the album by `jellyfin:` id).
 */
export async function refreshJellyfinRgMbidCache(): Promise<{
    processed: number;
    cached: number;
    skipped: number;
}> {
    if (!(await isJellyfinMusicSource())) return { processed: 0, cached: 0, skipped: 0 };

    const cfg = await getJellyfinConfig();
    if (!cfg) return { processed: 0, cached: 0, skipped: 0 };
    if (!redisClient.isReady) return { processed: 0, cached: 0, skipped: 0 };

    let processed = 0;
    let cached = 0;
    let skipped = 0;
    let offset = 0;

    logger.debug("[JellyfinRgMbidCache] Refreshing rgMbid -> Jellyfin id cache...");

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

                const rawJfId = album.id.startsWith("jellyfin:")
                    ? album.id.slice("jellyfin:".length)
                    : album.id;

                try {
                    await redisClient.setEx(
                        `jf:rgmbid:${album.rgMbid}`,
                        RGMBID_CACHE_TTL_SECONDS,
                        rawJfId
                    );
                    cached++;
                } catch (err: any) {
                    logger.debug(
                        `[JellyfinRgMbidCache] Redis SET failed for album "${album.title}":`,
                        err?.message
                    );
                    skipped++;
                }
            }

            offset += albums.length;
            if (offset >= total || albums.length < 100) break;
        }

        logger.info(
            `[JellyfinRgMbidCache] Done: ${processed} albums, ${cached} cached, ${skipped} skipped`
        );
    } catch (err: any) {
        logger.error("[JellyfinRgMbidCache] Failed:", err?.message || err);
    }

    return { processed, cached, skipped };
}
