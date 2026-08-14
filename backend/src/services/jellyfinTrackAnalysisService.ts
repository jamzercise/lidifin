/**
 * Service wrapper around the `JellyfinTrackAnalysis` table introduced in
 * Arch-X.b.1.
 *
 * Purpose:
 *   - Provide a small, intention-revealing API for the audio analyzer to
 *     record its results without each writer spelling out the exact upsert
 *     payload (and accidentally drifting on status transitions).
 *   - Provide narrow read paths for mix generators / mood buckets so they
 *     don't construct ad-hoc Prisma queries against a wide table.
 *
 * The Essentia worker (`services/audio-analyzer/analyzer.py`) writes
 * directly to PostgreSQL for both `Track` and `JellyfinTrackAnalysis`
 * (see Arch-X.b.W). Other analyzers may use HTTP endpoints. This
 * service is the canonical place for any new endpoint or worker that needs
 * to read or write Jellyfin track analysis data — and the future migration target
 * for the existing routes that still operate against `Track`. See
 * `prisma/schema.prisma#JellyfinTrackAnalysis` for the full schema and
 * the X.b sequence (X.b.2/X.b.3 migrate writers and readers).
 *
 * Identity contract:
 *   `jellyfinTrackId` MUST be in `jellyfin:UUID` form. Callers that
 *   receive a raw 32-char Jellyfin item id should prefix it before
 *   calling these helpers; we do not silently normalize because the
 *   concept of "raw" vs "prefixed" id has different meanings in
 *   different parts of the codebase and converging here would mask bugs.
 */

import { prisma } from "../utils/db";
import type { JellyfinTrackAnalysis, Prisma } from "@prisma/client";

export type JellyfinTrackAnalysisStatus =
    | "pending"
    | "processing"
    | "completed"
    | "failed";

/**
 * Numeric + tag results from the audio analyzer (Essentia/MusiCNN/etc).
 * Mirrors the analyzer's output payload — every field is optional so the
 * caller can pass through whichever subset its analyzer version produces.
 */
export interface AudioAnalysisResultPayload {
    bpm?: number | null;
    beatsCount?: number | null;
    key?: string | null;
    keyScale?: string | null;
    keyStrength?: number | null;
    energy?: number | null;
    loudness?: number | null;
    dynamicRange?: number | null;
    danceability?: number | null;
    valence?: number | null;
    arousal?: number | null;
    instrumentalness?: number | null;
    acousticness?: number | null;
    speechiness?: number | null;
    moodHappy?: number | null;
    moodSad?: number | null;
    moodRelaxed?: number | null;
    moodAggressive?: number | null;
    moodParty?: number | null;
    moodAcoustic?: number | null;
    moodElectronic?: number | null;
    danceabilityMl?: number | null;
    moodTags?: string[];
    essentiaGenres?: string[];
    analysisVersion?: string | null;
    analysisMode?: string | null;
}

/**
 * Validates `jellyfin:UUID` shape. Lightweight on purpose; we only need
 * to reject obviously-wrong inputs (raw cuids, raw uuids, empty strings)
 * before they hit the DB. The prefix discriminates from `Track.id`.
 */
const JELLYFIN_ID_REGEX = /^jellyfin:[a-f0-9]{32}$/i;

function assertJellyfinTrackId(id: string): void {
    if (!JELLYFIN_ID_REGEX.test(id)) {
        throw new Error(
            `jellyfinTrackId must be in 'jellyfin:UUID' form, got: ${id}`
        );
    }
}

/**
 * Read a single analysis row by Jellyfin id. Returns `null` when no
 * analysis has been recorded yet (not an error).
 */
export async function findByJellyfinTrackId(
    id: string
): Promise<JellyfinTrackAnalysis | null> {
    assertJellyfinTrackId(id);
    return prisma.jellyfinTrackAnalysis.findUnique({
        where: { jellyfinTrackId: id },
    });
}

/**
 * Bulk read for hot paths (e.g., mix generator candidate filtering).
 * Returns rows in arbitrary order; callers should not depend on input
 * ordering. Empty input returns an empty array without hitting the DB.
 */
export async function findManyByJellyfinTrackIds(
    ids: string[]
): Promise<JellyfinTrackAnalysis[]> {
    if (ids.length === 0) return [];
    for (const id of ids) assertJellyfinTrackId(id);
    return prisma.jellyfinTrackAnalysis.findMany({
        where: { jellyfinTrackId: { in: ids } },
    });
}

/**
 * Mark a track's audio analysis as "processing" and stamp the start
 * time. Idempotent — calling on an already-processing row is a no-op
 * status-wise but still refreshes `analysisStartedAt`.
 *
 * Used by the audio analyzer's pre-flight to claim a track from the
 * queue. If you need atomic claim semantics under contention, layer a
 * Redis lock on top — Postgres row locks are not used here because the
 * queue is single-consumer per track id.
 */
export async function markAudioAnalysisStarted(
    id: string
): Promise<JellyfinTrackAnalysis> {
    assertJellyfinTrackId(id);
    const now = new Date();
    return prisma.jellyfinTrackAnalysis.upsert({
        where: { jellyfinTrackId: id },
        create: {
            jellyfinTrackId: id,
            analysisStatus: "processing",
            analysisStartedAt: now,
        },
        update: {
            analysisStatus: "processing",
            analysisStartedAt: now,
            analysisError: null,
        },
    });
}

/**
 * Persist successful audio analysis results. Sets `analysisStatus =
 * "completed"`, stamps `analyzedAt`, and clears any previous error.
 *
 * Pre-existing tag arrays are replaced when the payload includes them.
 * Numeric fields not present in the payload are left untouched so that
 * partial analyzer outputs (e.g., a BPM-only re-analysis) don't wipe
 * earlier richer results.
 */
export async function recordAudioAnalysisCompleted(
    id: string,
    payload: AudioAnalysisResultPayload
): Promise<JellyfinTrackAnalysis> {
    assertJellyfinTrackId(id);
    const now = new Date();
    const writable: Prisma.JellyfinTrackAnalysisUpdateInput = {
        analysisStatus: "completed",
        analyzedAt: now,
        analysisError: null,
        analysisRetryCount: 0,
        ...numericUpdate(payload),
        ...(payload.analysisVersion !== undefined && {
            analysisVersion: payload.analysisVersion,
        }),
        ...(payload.analysisMode !== undefined && {
            analysisMode: payload.analysisMode,
        }),
        ...(payload.moodTags !== undefined && { moodTags: payload.moodTags }),
        ...(payload.essentiaGenres !== undefined && {
            essentiaGenres: payload.essentiaGenres,
        }),
    };
    return prisma.jellyfinTrackAnalysis.upsert({
        where: { jellyfinTrackId: id },
        create: {
            jellyfinTrackId: id,
            ...writable,
            // upsert.create requires non-update form; cast through
            // satisfies via a separate object.
        } as unknown as Prisma.JellyfinTrackAnalysisCreateInput,
        update: writable,
    });
}

/**
 * Mark audio analysis as failed and increment the retry counter. The
 * caller decides whether to re-queue based on retry policy; this helper
 * only records state.
 */
export async function recordAudioAnalysisFailed(
    id: string,
    errorMessage: string
): Promise<JellyfinTrackAnalysis> {
    assertJellyfinTrackId(id);
    const truncated = errorMessage.slice(0, 1000);
    return prisma.jellyfinTrackAnalysis.upsert({
        where: { jellyfinTrackId: id },
        create: {
            jellyfinTrackId: id,
            analysisStatus: "failed",
            analysisError: truncated,
            analysisRetryCount: 1,
        },
        update: {
            analysisStatus: "failed",
            analysisError: truncated,
            analysisRetryCount: { increment: 1 },
        },
    });
}

/**
 * Reset a row's audio analysis state to `pending`. Used by the
 * "retry-failed" admin endpoint to push tracks back through the queue
 * without losing accumulated analysis fields.
 */
export async function resetAudioAnalysisToPending(
    id: string
): Promise<JellyfinTrackAnalysis | null> {
    assertJellyfinTrackId(id);
    const existing = await prisma.jellyfinTrackAnalysis.findUnique({
        where: { jellyfinTrackId: id },
    });
    if (!existing) return null;
    return prisma.jellyfinTrackAnalysis.update({
        where: { jellyfinTrackId: id },
        data: {
            analysisStatus: "pending",
            analysisError: null,
            analysisStartedAt: null,
        },
    });
}

/**
 * Aggregate counts for the `/api/analysis/status` admin endpoint. Each
 * status appears at most once in the result, even when no rows match.
 */
export async function getAudioAnalysisStatusCounts(): Promise<
    Record<JellyfinTrackAnalysisStatus, number>
> {
    const grouped = await prisma.jellyfinTrackAnalysis.groupBy({
        by: ["analysisStatus"],
        _count: true,
    });
    const out: Record<JellyfinTrackAnalysisStatus, number> = {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
    };
    for (const row of grouped) {
        const status = row.analysisStatus as JellyfinTrackAnalysisStatus;
        if (status in out) out[status] = row._count;
    }
    return out;
}

/**
 * Build the numeric-only subset of an update payload. Skipped because
 * the result is fed directly into Prisma update/upsert which already
 * understands `undefined` as "leave alone". Extracted so the
 * `recordAudioAnalysisCompleted` body stays readable.
 */
function numericUpdate(
    payload: AudioAnalysisResultPayload
): Prisma.JellyfinTrackAnalysisUpdateInput {
    const out: Prisma.JellyfinTrackAnalysisUpdateInput = {};
    const numericKeys: Array<
        keyof Pick<
            AudioAnalysisResultPayload,
            | "bpm"
            | "beatsCount"
            | "key"
            | "keyScale"
            | "keyStrength"
            | "energy"
            | "loudness"
            | "dynamicRange"
            | "danceability"
            | "valence"
            | "arousal"
            | "instrumentalness"
            | "acousticness"
            | "speechiness"
            | "moodHappy"
            | "moodSad"
            | "moodRelaxed"
            | "moodAggressive"
            | "moodParty"
            | "moodAcoustic"
            | "moodElectronic"
            | "danceabilityMl"
        >
    > = [
        "bpm",
        "beatsCount",
        "key",
        "keyScale",
        "keyStrength",
        "energy",
        "loudness",
        "dynamicRange",
        "danceability",
        "valence",
        "arousal",
        "instrumentalness",
        "acousticness",
        "speechiness",
        "moodHappy",
        "moodSad",
        "moodRelaxed",
        "moodAggressive",
        "moodParty",
        "moodAcoustic",
        "moodElectronic",
        "danceabilityMl",
    ];
    for (const key of numericKeys) {
        const value = payload[key];
        if (value !== undefined) {
            (out as Record<string, unknown>)[key] = value;
        }
    }
    return out;
}
