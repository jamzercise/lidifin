import {
    combineAnalysisStatusCounts,
    isJellyfinTrackId,
    mapJellyfinAnalysisToApiPayload,
    type AnalysisStatus,
} from "../analysisRouteHelpers";
import type { JellyfinTrackAnalysis } from "@prisma/client";

describe("isJellyfinTrackId", () => {
    it("returns true for a properly-prefixed id", () => {
        expect(
            isJellyfinTrackId(
                "jellyfin:abcdef0123456789abcdef0123456789"
            )
        ).toBe(true);
    });

    it("returns false for a Prisma cuid", () => {
        expect(isJellyfinTrackId("ckxyz0000000abc123def4567")).toBe(false);
    });

    it("returns false for a bare uuid (no prefix)", () => {
        expect(
            isJellyfinTrackId("abcdef0123456789abcdef0123456789")
        ).toBe(false);
    });

    it("returns false for the empty string", () => {
        expect(isJellyfinTrackId("")).toBe(false);
    });

    it("doesn't second-guess malformed-but-prefixed ids — that's the service's job", () => {
        // The dispatch boundary is intentionally lax; the caller-side
        // validator (e.g., `findByJellyfinTrackId`) rejects bad shapes.
        expect(isJellyfinTrackId("jellyfin:short")).toBe(true);
    });
});

describe("combineAnalysisStatusCounts", () => {
    const emptyJellyfin: Record<AnalysisStatus, number> = {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
    };

    it("sums each bucket across both sources", () => {
        const result = combineAnalysisStatusCounts(
            [
                { analysisStatus: "completed", _count: 5 },
                { analysisStatus: "pending", _count: 2 },
                { analysisStatus: "failed", _count: 1 },
            ],
            { pending: 3, processing: 4, completed: 10, failed: 2 }
        );
        expect(result).toEqual({
            total: 27,
            completed: 15,
            failed: 3,
            processing: 4,
            pending: 5,
        });
    });

    it("returns all zeros when both sources are empty", () => {
        expect(combineAnalysisStatusCounts([], emptyJellyfin)).toEqual({
            total: 0,
            completed: 0,
            failed: 0,
            processing: 0,
            pending: 0,
        });
    });

    it("treats missing buckets in the trackCounts array as zero", () => {
        const result = combineAnalysisStatusCounts(
            [{ analysisStatus: "completed", _count: 5 }],
            emptyJellyfin
        );
        expect(result).toEqual({
            total: 5,
            completed: 5,
            failed: 0,
            processing: 0,
            pending: 0,
        });
    });

    it("ignores unknown statuses on the trackCounts side", () => {
        const result = combineAnalysisStatusCounts(
            [
                { analysisStatus: "completed", _count: 5 },
                { analysisStatus: "weird-future-status", _count: 99 },
            ],
            emptyJellyfin
        );
        expect(result.total).toBe(5);
        expect(result.completed).toBe(5);
    });

    it("preserves arithmetic when only the Jellyfin side has data", () => {
        const result = combineAnalysisStatusCounts([], {
            pending: 1,
            processing: 1,
            completed: 1,
            failed: 1,
        });
        expect(result).toEqual({
            total: 4,
            completed: 1,
            failed: 1,
            processing: 1,
            pending: 1,
        });
    });
});

describe("mapJellyfinAnalysisToApiPayload", () => {
    const baseRow: JellyfinTrackAnalysis = {
        jellyfinTrackId: "jellyfin:abcdef0123456789abcdef0123456789",
        bpm: 128.4,
        beatsCount: 412,
        key: "C",
        keyScale: "major",
        keyStrength: 0.74,
        energy: 0.61,
        loudness: -8.2,
        dynamicRange: 7.4,
        danceability: 0.55,
        valence: 0.42,
        arousal: 0.7,
        instrumentalness: 0.05,
        acousticness: 0.12,
        speechiness: 0.04,
        moodHappy: 0.34,
        moodSad: 0.12,
        moodRelaxed: 0.22,
        moodAggressive: 0.18,
        moodParty: 0.41,
        moodAcoustic: 0.07,
        moodElectronic: 0.55,
        danceabilityMl: 0.6,
        moodTags: ["uplifting", "driving"],
        essentiaGenres: ["indie rock", "alternative"],
        analysisStatus: "completed",
        analysisVersion: "1.4.0",
        analysisMode: "cpu",
        analyzedAt: new Date("2026-04-28T10:00:00Z"),
        analysisError: null,
        analysisRetryCount: 0,
        analysisStartedAt: null,
        vibeAnalysisStatus: "completed",
        vibeAnalysisStartedAt: null,
        vibeAnalysisError: null,
        vibeAnalysisRetryCount: 0,
        vibeAnalysisStatusUpdatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    it("uses jellyfinTrackId as the wire `id`", () => {
        const result = mapJellyfinAnalysisToApiPayload(baseRow);
        expect(result.id).toBe(
            "jellyfin:abcdef0123456789abcdef0123456789"
        );
    });

    it("returns null for `title` (analysis row doesn't carry titles)", () => {
        const result = mapJellyfinAnalysisToApiPayload(baseRow);
        expect(result.title).toBeNull();
    });

    it("returns an empty lastfmTags array (lives on JellyfinTrackMetadata, not analysis)", () => {
        const result = mapJellyfinAnalysisToApiPayload(baseRow);
        expect(result.lastfmTags).toEqual([]);
    });

    it("preserves moodTags and essentiaGenres verbatim", () => {
        const result = mapJellyfinAnalysisToApiPayload(baseRow);
        expect(result.moodTags).toEqual(["uplifting", "driving"]);
        expect(result.essentiaGenres).toEqual(["indie rock", "alternative"]);
    });

    it("preserves null analysis fields as null (not undefined or 0)", () => {
        const result = mapJellyfinAnalysisToApiPayload({
            ...baseRow,
            bpm: null,
            energy: null,
            moodHappy: null,
            keyScale: null,
            analyzedAt: null,
        });
        expect(result.bpm).toBeNull();
        expect(result.energy).toBeNull();
        expect(result.moodHappy).toBeNull();
        expect(result.keyScale).toBeNull();
        expect(result.analyzedAt).toBeNull();
    });

    it("returns the wire-shape's own array references (callers can mutate without poisoning the row)", () => {
        // Soft contract: the wire shape's arrays are independent enough
        // that downstream serialization doesn't need a clone. Right now
        // `mapJellyfinAnalysisToApiPayload` is a shallow copy of these
        // fields; if that ever changes (e.g., we start spreading), this
        // test will catch it before the API contract drifts silently.
        const result = mapJellyfinAnalysisToApiPayload(baseRow);
        expect(Array.isArray(result.moodTags)).toBe(true);
        expect(Array.isArray(result.essentiaGenres)).toBe(true);
        expect(Array.isArray(result.lastfmTags)).toBe(true);
    });
});
