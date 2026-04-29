/**
 * Pure helpers for the analysis admin routes (`/api/analysis/*`).
 *
 * Extracted so the dispatch + aggregation logic that joins the legacy
 * `Track`-backed analysis pipeline with the X.b.1
 * `JellyfinTrackAnalysis` storage stays unit-testable without spinning
 * up Express or Prisma. The route handlers wire these into the real
 * data sources.
 */

import type { JellyfinTrackAnalysis } from "@prisma/client";

/**
 * The four lifecycle states tracked by both pipelines. Treated as a
 * closed set for status-aggregation; unknown statuses (e.g. mid-flight
 * status names introduced by future analyzer versions) are dropped on
 * the floor by `combineAnalysisStatusCounts`.
 */
export type AnalysisStatus =
    | "pending"
    | "processing"
    | "completed"
    | "failed";

export interface AggregatedAnalysisCounts {
    total: number;
    completed: number;
    failed: number;
    processing: number;
    pending: number;
}

/**
 * Track ids surface in two disjoint namespaces:
 *   - Prisma cuid → `Track.id` (legacy local-files-mode storage).
 *   - `jellyfin:UUID` → `JellyfinTrackAnalysis.jellyfinTrackId` (X.b.1).
 *
 * This single check is the dispatch boundary used by both the read
 * route and the aggregation route.
 */
export function isJellyfinTrackId(trackId: string): boolean {
    return trackId.startsWith("jellyfin:");
}

/**
 * Combine status-bucket counts from the two analysis tables into a
 * single dashboard payload. Unknown statuses on either side are
 * ignored rather than thrown — the dashboard should keep rendering
 * if a future analyzer version introduces a new status before the
 * route catches up.
 */
export function combineAnalysisStatusCounts(
    trackCounts: Array<{ analysisStatus: string; _count: number }>,
    jellyfinCounts: Record<AnalysisStatus, number>
): AggregatedAnalysisCounts {
    const trackBucket = (status: AnalysisStatus): number =>
        trackCounts.find((s) => s.analysisStatus === status)?._count ?? 0;

    const completed = trackBucket("completed") + jellyfinCounts.completed;
    const failed = trackBucket("failed") + jellyfinCounts.failed;
    const processing = trackBucket("processing") + jellyfinCounts.processing;
    const pending = trackBucket("pending") + jellyfinCounts.pending;
    const total = completed + failed + processing + pending;

    return { total, completed, failed, processing, pending };
}

/**
 * Wire shape returned by `GET /api/analysis/track/:trackId`. Mirrors
 * the legacy `Track`-backed payload field-for-field so admin UIs and
 * debug consumers don't have to branch on which namespace owns the
 * track.
 *
 * `lastfmTags` is empty when the source row is a
 * `JellyfinTrackAnalysis`: in the Jellyfin-mode split, lastfm tags
 * live on `JellyfinTrackMetadata`. Callers that need both fetch them
 * separately rather than have us mash two reads together here.
 */
export interface TrackAnalysisApiPayload {
    id: string;
    title: string | null;
    analysisStatus: string;
    analysisError: string | null;
    analyzedAt: Date | null;
    analysisVersion: string | null;
    analysisMode: string | null;
    bpm: number | null;
    beatsCount: number | null;
    key: string | null;
    keyScale: string | null;
    keyStrength: number | null;
    energy: number | null;
    loudness: number | null;
    dynamicRange: number | null;
    danceability: number | null;
    valence: number | null;
    arousal: number | null;
    instrumentalness: number | null;
    acousticness: number | null;
    speechiness: number | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
    moodTags: string[];
    essentiaGenres: string[];
    lastfmTags: string[];
}

/**
 * Project a `JellyfinTrackAnalysis` row onto the route's API shape.
 * Title is `null` because the analysis row doesn't carry track title
 * (that lives on Jellyfin / `JellyfinTrackMetadata`); admin UIs that
 * want the title should resolve via Jellyfin in a separate call.
 */
export function mapJellyfinAnalysisToApiPayload(
    analysis: JellyfinTrackAnalysis
): TrackAnalysisApiPayload {
    return {
        id: analysis.jellyfinTrackId,
        title: null,
        analysisStatus: analysis.analysisStatus,
        analysisError: analysis.analysisError,
        analyzedAt: analysis.analyzedAt,
        analysisVersion: analysis.analysisVersion,
        analysisMode: analysis.analysisMode,
        bpm: analysis.bpm,
        beatsCount: analysis.beatsCount,
        key: analysis.key,
        keyScale: analysis.keyScale,
        keyStrength: analysis.keyStrength,
        energy: analysis.energy,
        loudness: analysis.loudness,
        dynamicRange: analysis.dynamicRange,
        danceability: analysis.danceability,
        valence: analysis.valence,
        arousal: analysis.arousal,
        instrumentalness: analysis.instrumentalness,
        acousticness: analysis.acousticness,
        speechiness: analysis.speechiness,
        moodHappy: analysis.moodHappy,
        moodSad: analysis.moodSad,
        moodRelaxed: analysis.moodRelaxed,
        moodAggressive: analysis.moodAggressive,
        moodParty: analysis.moodParty,
        moodAcoustic: analysis.moodAcoustic,
        moodElectronic: analysis.moodElectronic,
        moodTags: analysis.moodTags,
        essentiaGenres: analysis.essentiaGenres,
        lastfmTags: [],
    };
}
