/**
 * Precomputed library list cache – stores owned-album ID lists in Redis so GET /library/albums
 * can serve from cache and avoid heavy DB queries on every request.
 *
 * - Refresh runs every 5 minutes (or on demand after a scan).
 * - Cache key per sort order: lib:albums:owned:ids:{sortBy}
 * - TTL 5 minutes; list endpoints read from cache when available and fall back to DB on miss.
 */

import { prisma, Prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

const CACHE_KEY_PREFIX = "lib:albums:owned:ids:";
const TTL_SEC = 5 * 60; // 5 minutes
/** Cap cached IDs to avoid huge JSON and long sync work / GC in the API when reading cache */
const MAX_CACHED_IDS = 50_000;
const SORT_OPTIONS = ["name", "name-desc", "recent"] as const;

function cacheKey(sortBy: string): string {
    return `${CACHE_KEY_PREFIX}${sortBy}`;
}

/**
 * Refresh the precomputed list of owned album IDs for a given sort order.
 * Called by the scheduler and optionally after library scan.
 */
export async function refreshOwnedAlbumsCache(sortBy: string): Promise<number> {
    const orderClause =
        sortBy === "name-desc"
            ? Prisma.raw('a."title" DESC')
            : sortBy === "recent"
              ? Prisma.raw('a."year" DESC NULLS LAST')
              : Prisma.raw('a."title" ASC');

    // After Arch-X.d, all `Album` rows are owned/library content
    // (DISCOVER rows + OwnedAlbum + AlbumOwnershipFact were removed).
    // The "has tracks" predicate keeps cache identical to legacy
    // behavior — tracks-less rows shouldn't be served as owned.
    const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT a.id
        FROM "Album" a
        WHERE EXISTS (SELECT 1 FROM "Track" t WHERE t."albumId" = a.id)
        ORDER BY ${orderClause}
        LIMIT ${MAX_CACHED_IDS}
    `;

    const ids = rows.map((r) => r.id);
    const key = cacheKey(sortBy);

    if (!redisClient.isReady) {
        logger.debug(`[LibraryListCache] Redis not ready, skip cache set for ${sortBy}`);
        return ids.length;
    }

    try {
        await redisClient.setEx(key, TTL_SEC, JSON.stringify(ids));
        logger.debug(`[LibraryListCache] Refreshed ${sortBy}: ${ids.length} album IDs`);
    } catch (err) {
        logger.warn("[LibraryListCache] Failed to set cache:", err);
    }

    return ids.length;
}

/**
 * Refresh all sort orders. Run periodically (e.g. every 5 min) or after library scan.
 */
export async function refreshAllOwnedAlbumsCache(): Promise<void> {
    for (const sortBy of SORT_OPTIONS) {
        try {
            await refreshOwnedAlbumsCache(sortBy);
        } catch (err) {
            logger.warn(`[LibraryListCache] Refresh failed for ${sortBy}:`, err);
        }
    }
}

/**
 * Get owned album IDs from cache for a sort order. Returns null on miss or error.
 */
export async function getCachedOwnedAlbumIds(sortBy: string): Promise<string[] | null> {
    if (!redisClient.isReady) return null;
    const key = cacheKey(sortBy);
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        const ids = JSON.parse(raw) as string[];
        if (!Array.isArray(ids) || ids.length > MAX_CACHED_IDS) return null;
        return ids;
    } catch {
        return null;
    }
}

/**
 * Invalidate cache (e.g. after a scan so next request refetches). Optional.
 */
export async function invalidateOwnedAlbumsCache(): Promise<void> {
    if (!redisClient.isReady) return;
    try {
        for (const sortBy of SORT_OPTIONS) {
            await redisClient.del(cacheKey(sortBy));
        }
        logger.debug("[LibraryListCache] Invalidated owned albums cache");
    } catch (err) {
        logger.warn("[LibraryListCache] Invalidate failed:", err);
    }
}

let refreshIntervalId: NodeJS.Timeout | null = null;

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Start the periodic refresh. Call from worker or API (one process only).
 */
export function startLibraryListCacheRefresh(): void {
    if (refreshIntervalId) return;
    refreshIntervalId = setInterval(() => {
        refreshAllOwnedAlbumsCache().catch((err) => {
            logger.warn("[LibraryListCache] Scheduled refresh failed:", err);
        });
    }, REFRESH_INTERVAL_MS);
    logger.debug("[LibraryListCache] Scheduled refresh every 5 minutes");
}

/**
 * Stop the periodic refresh (e.g. on shutdown).
 */
export function stopLibraryListCacheRefresh(): void {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
}
