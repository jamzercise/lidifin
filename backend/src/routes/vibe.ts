/**
 * Vibe routes: natural-language search and track-to-track similarity.
 *
 * These used to run on a bundled CLAP analyzer that embedded local files and
 * keyed the vectors to the Prisma `Track` table. That combination cannot work in
 * Jellyfin-first mode — `Track` is empty and there are no local file paths — so
 * the work now goes to AudioMuse-AI, which analyzes the Jellyfin library itself
 * and answers in Jellyfin item IDs.
 */

import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { requireAuth } from "../middleware/auth";
import { findSimilarTracks } from "../services/hybridSimilarity";
import {
    getClapStats,
    getClapTopQueries,
    getSimilarTracks,
    searchByText,
    warmupClap,
    type AudioMuseUnavailableReason,
} from "../services/audioMuseService";
import {
    isJellyfinMusicSource,
    resolveTrackReferences,
    type ResolvedTrack,
} from "../services/jellyfin";

const router = Router();

const JELLYFIN_PREFIX = "jellyfin:";

/**
 * Cosine distance (0 identical, 2 opposite) to a 0-1 match score, for endpoints
 * that report a distance rather than a similarity.
 */
function distanceToSimilarity(distance: number): number {
    return Math.max(0, 1 - distance / 2);
}

/** A missing AudioMuse is a configuration problem, not a server fault. */
function statusForReason(reason?: AudioMuseUnavailableReason): number {
    return reason === "failed" ? 500 : 503;
}

function formatTrack(
    track: ResolvedTrack,
    scores: { similarity: number; distance: number }
) {
    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        trackNo: 0,
        distance: scores.distance,
        similarity: scores.similarity,
        album: {
            id: track.album.id,
            title: track.album.title,
            coverUrl: track.album.coverArt,
        },
        artist: track.artist,
    };
}

/**
 * Turn AudioMuse item IDs into full tracks, preserving AudioMuse's ordering and
 * scores. Tracks Jellyfin no longer serves resolve to null and are dropped.
 */
async function resolveScoredTracks(
    scored: { itemId: string; similarity: number; distance: number }[]
) {
    const resolved = await resolveTrackReferences(
        scored.map((s) => `${JELLYFIN_PREFIX}${s.itemId}`)
    );
    return resolved
        .map((track, i) => (track ? formatTrack(track, scored[i]) : null))
        .filter((t): t is NonNullable<typeof t> => t !== null);
}

/** Library size, for showing analysis coverage as a percentage. */
async function countLibraryTracks(): Promise<number> {
    return (await isJellyfinMusicSource())
        ? prisma.jellyfinTrackMetadata.count()
        : prisma.track.count();
}

/**
 * GET /api/vibe/similar/:trackId
 * Sonically similar tracks. Jellyfin IDs go to AudioMuse; native IDs keep using
 * local audio-feature similarity.
 */
router.get("/similar/:trackId", requireAuth, async (req, res) => {
    try {
        const { trackId } = req.params;
        const limit = Math.min(
            Math.max(1, parseInt(req.query.limit as string) || 20),
            100
        );

        if (trackId.startsWith(JELLYFIN_PREFIX)) {
            const { tracks: similar, error } = await getSimilarTracks(trackId, limit);
            if (error) {
                return res.status(503).json({
                    error: "Similar tracks unavailable",
                    message: error,
                });
            }
            const tracks = await resolveScoredTracks(
                similar.map((t) => ({
                    itemId: t.itemId,
                    distance: t.distance,
                    similarity: distanceToSimilarity(t.distance),
                }))
            );
            if (tracks.length === 0) {
                return res.status(404).json({
                    error: "No similar tracks found",
                    message:
                        "AudioMuse-AI has no sonic neighbours for this track yet. Run an analysis in AudioMuse if you have added music recently.",
                });
            }
            return res.json({ sourceTrackId: trackId, tracks });
        }

        const tracks = await findSimilarTracks(trackId, limit);

        if (tracks.length === 0) {
            return res.status(404).json({
                error: "No similar tracks found",
                message: "This track may not have been analyzed yet, or no analyzer is running",
            });
        }

        res.json({
            sourceTrackId: trackId,
            tracks: tracks.map((t) => ({
                id: t.id,
                title: t.title,
                distance: t.distance,
                similarity: t.similarity,
                album: {
                    id: t.albumId,
                    title: t.albumTitle,
                    coverUrl: t.albumCoverUrl,
                },
                artist: {
                    id: t.artistId,
                    name: t.artistName,
                },
            })),
        });
    } catch (error: any) {
        logger.error("Vibe similarity error:", error);
        res.status(500).json({ error: "Failed to find similar tracks" });
    }
});

/**
 * POST /api/vibe/search
 * Natural-language track search, e.g. "calm piano songs".
 */
router.post("/search", requireAuth, async (req, res) => {
    try {
        const { query, limit: requestedLimit, minSimilarity } = req.body;

        if (!query || typeof query !== "string" || query.trim().length < 2) {
            return res.status(400).json({
                error: "Query must be at least 2 characters",
            });
        }

        const limit = Math.min(Math.max(1, requestedLimit || 20), 100);

        // AudioMuse already ranks and truncates, and its similarity scale is its
        // own, so no floor is applied unless the caller asks for one.
        const similarityThreshold =
            typeof minSimilarity === "number"
                ? Math.max(0, Math.min(1, minSimilarity))
                : 0;

        const { tracks: matches, error, reason } = await searchByText(query, limit);

        if (error) {
            return res.status(statusForReason(reason)).json({
                error: "Vibe search unavailable",
                message: error,
                reason,
            });
        }

        const tracks = await resolveScoredTracks(
            matches
                .filter((m) => m.similarity >= similarityThreshold)
                .map((m) => ({
                    itemId: m.itemId,
                    similarity: m.similarity,
                    distance: 2 * (1 - m.similarity),
                }))
        );

        res.json({
            query: query.trim(),
            tracks,
            minSimilarity: similarityThreshold,
            totalAboveThreshold: tracks.length,
        });
    } catch (error: any) {
        logger.error("Vibe text search error:", error);
        res.status(500).json({ error: "Failed to search tracks by vibe" });
    }
});

/**
 * GET /api/vibe/status
 * How much of the library AudioMuse has embedded.
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        const [{ stats, error, reason }, totalTracks] = await Promise.all([
            getClapStats(),
            countLibraryTracks(),
        ]);

        if (!stats) {
            return res.json({
                totalTracks,
                embeddedTracks: 0,
                progress: 0,
                isComplete: false,
                available: false,
                message: error,
                reason,
            });
        }

        const embeddedCount = stats.numEmbeddings;
        const progress =
            totalTracks > 0
                ? Math.min(100, Math.round((embeddedCount / totalTracks) * 100))
                : 0;

        res.json({
            totalTracks,
            embeddedTracks: embeddedCount,
            progress,
            isComplete: embeddedCount > 0 && embeddedCount >= totalTracks,
            available: stats.clapEnabled && embeddedCount > 0,
            lastRefresh: stats.lastRefresh,
        });
    } catch (error: any) {
        logger.error("Vibe status error:", error);
        res.status(500).json({ error: "Failed to get embedding status" });
    }
});

/**
 * GET /api/vibe/suggestions
 * Suggested queries AudioMuse derived from this library, for search placeholders
 * and the Discover mood shelf.
 */
router.get("/suggestions", requireAuth, async (req, res) => {
    try {
        const { queries, ready } = await getClapTopQueries();
        res.json({ queries, ready });
    } catch (error: any) {
        logger.error("Vibe suggestions error:", error);
        res.json({ queries: [], ready: false });
    }
});

/**
 * POST /api/vibe/warmup
 * Preload AudioMuse's search model so the first query is fast. Best-effort.
 */
router.post("/warmup", requireAuth, async (req, res) => {
    void warmupClap();
    res.status(202).json({ warming: true });
});

export default router;
