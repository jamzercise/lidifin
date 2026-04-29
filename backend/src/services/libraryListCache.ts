/**
 * Precomputed album-list cache for Prisma-backed libraries (non-Jellyfin source).
 * Stores album IDs that have ≥1 track in Redis so GET /library/albums can avoid
 * heavy list queries.
 *
 * - Refresh: every 5 minutes and after scan (worker).
 * - Key per sort: lib:albums:owned:ids:{sortBy} (legacy segment; means "local mirror albums").
 * - TTL 5 minutes; reads fall back to DB on miss.
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
 * Refresh cached album IDs for one sort order (Prisma albums that have tracks).
 */
export async function refreshPrismaAlbumListCache(sortBy: string): Promise<number> {
    const orderClause =
        sortBy === "name-desc"
            ? Prisma.raw('a."title" DESC')
            : sortBy === "recent"
              ? Prisma.raw('a."year" DESC NULLS LAST')
              : Prisma.raw('a."title" ASC');

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

/** Refresh all sort orders (scheduler and post-scan). */
export async function refreshAllPrismaAlbumListCaches(): Promise<void> {
    for (const sortBy of SORT_OPTIONS) {
        try {
            await refreshPrismaAlbumListCache(sortBy);
        } catch (err) {
            logger.warn(`[LibraryListCache] Refresh failed for ${sortBy}:`, err);
        }
    }
}

/** Read cached album IDs for a sort order, or null on miss / error. */
export async function getCachedPrismaAlbumListIds(
    sortBy: string
): Promise<string[] | null> {
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

let refreshIntervalId: NodeJS.Timeout | null = null;

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** Periodic Prisma album-list refresh (worker only). */
export function startLibraryListCacheRefresh(): void {
    if (refreshIntervalId) return;
    refreshIntervalId = setInterval(() => {
        refreshAllPrismaAlbumListCaches().catch((err) => {
            logger.warn("[LibraryListCache] Scheduled refresh failed:", err);
        });
    }, REFRESH_INTERVAL_MS);
    logger.debug("[LibraryListCache] Scheduled refresh every 5 minutes");
}

export function stopLibraryListCacheRefresh(): void {
    if (refreshIntervalId) {
        clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
}
