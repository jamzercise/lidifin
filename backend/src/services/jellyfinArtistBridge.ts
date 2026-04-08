/**
 * Jellyfin Artist Bridge Service
 *
 * Maps Jellyfin artist names/IDs to native Artist records in the database.
 * This allows Jellyfin listening history to feed into the recommendation engine,
 * Discover Weekly seeding, and other personalization features that depend on
 * the native Artist → SimilarArtist graph.
 */

import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { musicBrainzService } from "./musicbrainz";
import { normalizeArtistName } from "../utils/artistNormalization";

const BRIDGE_CACHE_PREFIX = "jf-artist-bridge:";
const BRIDGE_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days
const BRIDGE_NOT_FOUND = "__NOT_FOUND__";

export interface BridgedArtist {
    nativeId: string;
    name: string;
    mbid: string;
}

/**
 * Resolve a Jellyfin artist name (and optional MBID from JellyfinTrackMetadata)
 * to a native Artist record. Creates a lightweight Artist if one doesn't exist
 * but an MBID can be resolved via MusicBrainz.
 *
 * Returns null if the artist cannot be resolved to a valid MBID.
 */
export async function resolveJellyfinArtistToNative(
    artistName: string,
    mbid?: string | null
): Promise<BridgedArtist | null> {
    if (!artistName?.trim()) return null;

    const cacheKey = `${BRIDGE_CACHE_PREFIX}${mbid || normalizeArtistName(artistName)}`;

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached === BRIDGE_NOT_FOUND) return null;
        if (cached) {
            const parsed = JSON.parse(cached) as BridgedArtist;
            // Guard against stale cache entries (e.g. artist deleted/recreated).
            const stillExists = await prisma.artist.findUnique({
                where: { id: parsed.nativeId },
                select: { id: true, name: true, mbid: true },
            });
            if (stillExists && isValidMbid(stillExists.mbid)) {
                return {
                    nativeId: stillExists.id,
                    name: stillExists.name,
                    mbid: stillExists.mbid,
                };
            }
            // Stale bridge entry: remove and continue with fresh resolution.
            await redisClient.del(cacheKey).catch(() => {});
        }
    } catch {
        // Redis errors are non-critical
    }

    let result: BridgedArtist | null = null;

    // Strategy 1: Direct MBID lookup in native Artist table
    if (mbid && isValidMbid(mbid)) {
        const artist = await prisma.artist.findUnique({ where: { mbid } });
        if (artist) {
            result = { nativeId: artist.id, name: artist.name, mbid: artist.mbid };
        }
    }

    // Strategy 2: Normalized name match
    if (!result) {
        const normalized = normalizeArtistName(artistName);
        const artist = await prisma.artist.findFirst({
            where: { normalizedName: normalized },
        });
        if (artist && isValidMbid(artist.mbid)) {
            result = { nativeId: artist.id, name: artist.name, mbid: artist.mbid };
        }
    }

    // Strategy 3: MusicBrainz search → find or create native Artist
    if (!result) {
        try {
            const mbResults = await musicBrainzService.searchArtist(artistName, 3);
            if (mbResults && mbResults.length > 0) {
                const best = mbResults[0];
                const resolvedMbid = best.id;

                if (resolvedMbid && isValidMbid(resolvedMbid)) {
                    // Check if this MBID already exists as a native artist
                    let artist = await prisma.artist.findUnique({
                        where: { mbid: resolvedMbid },
                    });

                    if (!artist) {
                        // Create a lightweight native Artist record so that the
                        // enrichment worker can populate SimilarArtist edges later
                        artist = await prisma.artist.create({
                            data: {
                                mbid: resolvedMbid,
                                name: best.name || artistName,
                                normalizedName: normalizeArtistName(best.name || artistName),
                                enrichmentStatus: "pending",
                            },
                        });
                        logger.debug(
                            `[JellyfinBridge] Created native artist for "${artistName}" → ${resolvedMbid}`
                        );
                    }

                    result = { nativeId: artist.id, name: artist.name, mbid: artist.mbid };
                }
            }
        } catch (err) {
            logger.debug(
                `[JellyfinBridge] MusicBrainz lookup failed for "${artistName}":`,
                err instanceof Error ? err.message : err
            );
        }
    }

    // Cache the result (or the miss)
    try {
        if (result) {
            await redisClient.setEx(cacheKey, BRIDGE_CACHE_TTL, JSON.stringify(result));
        } else {
            await redisClient.setEx(cacheKey, BRIDGE_CACHE_TTL, BRIDGE_NOT_FOUND);
        }
    } catch {
        // Redis errors are non-critical
    }

    return result;
}

/**
 * Batch-resolve Jellyfin track IDs to native Artist records.
 * Reads JellyfinTrackMetadata for artist info, then bridges to native artists.
 *
 * Returns a Map of jellyfinTrackId → BridgedArtist (only for successfully resolved artists).
 */
export async function resolveJellyfinPlaysToBridgedArtists(
    jellyfinTrackIds: string[]
): Promise<Map<string, BridgedArtist>> {
    if (jellyfinTrackIds.length === 0) return new Map();

    // Strip jellyfin: prefix for metadata lookup
    const rawIds = jellyfinTrackIds.map((id) =>
        id.startsWith("jellyfin:") ? id : `jellyfin:${id}`
    );

    const metadata = await prisma.jellyfinTrackMetadata.findMany({
        where: { jellyfinId: { in: rawIds } },
        select: { jellyfinId: true, artistName: true, artistMbid: true },
    });

    // Group by unique artist to avoid duplicate resolution
    const artistGroups = new Map<string, { name: string; mbid: string | null; trackIds: string[] }>();
    for (const m of metadata) {
        const key = m.artistMbid || normalizeArtistName(m.artistName);
        const group = artistGroups.get(key);
        if (group) {
            group.trackIds.push(m.jellyfinId);
        } else {
            artistGroups.set(key, {
                name: m.artistName,
                mbid: m.artistMbid,
                trackIds: [m.jellyfinId],
            });
        }
    }

    const result = new Map<string, BridgedArtist>();

    // Resolve each unique artist (with concurrency limit)
    const pLimit = (await import("p-limit")).default;
    const limit = pLimit(5);

    await Promise.all(
        Array.from(artistGroups.values()).map((group) =>
            limit(async () => {
                const bridged = await resolveJellyfinArtistToNative(
                    group.name,
                    group.mbid
                );
                if (bridged) {
                    for (const trackId of group.trackIds) {
                        result.set(trackId, bridged);
                    }
                }
            })
        )
    );

    return result;
}

/**
 * Get seed artists from Jellyfin play history.
 * Returns unique artists with MBIDs, ordered by play frequency.
 */
export async function getJellyfinSeedArtists(
    userId: string,
    since: Date,
    maxSeeds: number
): Promise<BridgedArtist[]> {
    // Get recent plays that are jellyfin: tracks
    const recentPlays = await prisma.play.groupBy({
        by: ["trackId"],
        where: {
            userId,
            playedAt: { gte: since },
            trackId: { startsWith: "jellyfin:" },
        },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 100,
    });

    if (recentPlays.length === 0) return [];

    const trackIds = recentPlays.map((p) => p.trackId);
    const bridgeMap = await resolveJellyfinPlaysToBridgedArtists(trackIds);

    // Aggregate by artist, preserving play-count ordering
    const artistScores = new Map<string, { artist: BridgedArtist; score: number }>();
    for (const play of recentPlays) {
        const bridged = bridgeMap.get(play.trackId);
        if (!bridged) continue;

        const existing = artistScores.get(bridged.nativeId);
        if (existing) {
            existing.score += play._count.id;
        } else {
            artistScores.set(bridged.nativeId, {
                artist: bridged,
                score: play._count.id,
            });
        }
    }

    return Array.from(artistScores.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSeeds)
        .map((entry) => entry.artist);
}

function isValidMbid(mbid: string | null | undefined): mbid is string {
    return !!mbid && !mbid.startsWith("temp-") && mbid.length >= 32;
}
