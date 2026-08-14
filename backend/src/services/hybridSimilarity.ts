import { prisma } from "../utils/db";
import { featureDetection } from "./featureDetection";
import { logger } from "../utils/logger";

export interface SimilarTrack {
    id: string;
    title: string;
    distance: number;
    similarity: number;
    albumId: string;
    albumTitle: string;
    albumCoverUrl: string | null;
    artistId: string;
    artistName: string;
}

// Weights sum to 1.0
const FEATURES_ONLY_WEIGHTS = {
    energy: 0.267,
    valence: 0.222,
    bpm: 0.178,
    danceability: 0.133,
    acousticness: 0.089,
    instrumentalness: 0.067,
    key: 0.044,
};

/**
 * Similarity for native (non-Jellyfin) tracks, scored on locally analyzed audio
 * features. Jellyfin tracks never reach here — those go to AudioMuse, which does
 * its own embedding search.
 */
export async function findSimilarTracks(
    trackId: string,
    limit: number = 20
): Promise<SimilarTrack[]> {
    const features = await featureDetection.getFeatures();

    if (!features.musicCNN) {
        logger.warn("[SIMILARITY] No local audio analysis available");
        return [];
    }

    return findSimilarFeaturesOnly(trackId, limit);
}

async function findSimilarFeaturesOnly(
    trackId: string,
    limit: number
): Promise<SimilarTrack[]> {
    const results = await prisma.$queryRaw<SimilarTrack[]>`
        WITH source AS (
            SELECT energy, valence, bpm, danceability, acousticness, instrumentalness, key, "keyScale"
            FROM "Track"
            WHERE id = ${trackId}
        )
        SELECT
            t.id,
            t.title,
            0 as distance,
            (
                ${FEATURES_ONLY_WEIGHTS.energy} * (1 - ABS(COALESCE(t.energy, 0.5) - COALESCE(s.energy, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.valence} * (1 - ABS(COALESCE(t.valence, 0.5) - COALESCE(s.valence, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.bpm} * bpm_similarity(t.bpm, s.bpm) +
                ${FEATURES_ONLY_WEIGHTS.danceability} * (1 - ABS(COALESCE(t.danceability, 0.5) - COALESCE(s.danceability, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.acousticness} * (1 - ABS(COALESCE(t.acousticness, 0.5) - COALESCE(s.acousticness, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.instrumentalness} * (1 - ABS(COALESCE(t.instrumentalness, 0.5) - COALESCE(s.instrumentalness, 0.5))) +
                ${FEATURES_ONLY_WEIGHTS.key} * key_similarity(t.key, t."keyScale", s.key, s."keyScale")
            ) as similarity,
            a.id as "albumId",
            a.title as "albumTitle",
            a."coverUrl" as "albumCoverUrl",
            ar.id as "artistId",
            ar.name as "artistName"
        FROM "Track" t
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        CROSS JOIN source s
        WHERE t.id != ${trackId}
            AND t.energy IS NOT NULL
        ORDER BY similarity DESC
        LIMIT ${limit}
    `;

    return results;
}
