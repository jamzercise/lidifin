import { prisma } from "../../utils/db";
import {
    findByJellyfinTrackId,
    findManyByJellyfinTrackIds,
    getAudioAnalysisStatusCounts,
    markAudioAnalysisStarted,
    recordAudioAnalysisCompleted,
    recordAudioAnalysisFailed,
    resetAudioAnalysisToPending,
    setVibeAnalysisStatus,
} from "../jellyfinTrackAnalysisService";

jest.mock("../../utils/db", () => ({
    prisma: {
        jellyfinTrackAnalysis: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            upsert: jest.fn(),
            update: jest.fn(),
            groupBy: jest.fn(),
        },
    },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const ops = mockPrisma.jellyfinTrackAnalysis as unknown as {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    groupBy: jest.Mock;
};

const VALID_ID = "jellyfin:abcdef0123456789abcdef0123456789";
const ANOTHER_VALID_ID = "jellyfin:0011223344556677889900aabbccddee";

beforeEach(() => {
    jest.clearAllMocks();
});

describe("id validation", () => {
    it("rejects raw cuids", async () => {
        await expect(
            findByJellyfinTrackId("ckxyz0000000abc123def4567")
        ).rejects.toThrow(/jellyfinTrackId must be in/);
    });

    it("rejects raw 32-char UUIDs without the prefix", async () => {
        await expect(
            findByJellyfinTrackId("abcdef0123456789abcdef0123456789")
        ).rejects.toThrow(/jellyfinTrackId must be in/);
    });

    it("rejects empty string", async () => {
        await expect(findByJellyfinTrackId("")).rejects.toThrow();
    });

    it("rejects jellyfin: prefix with wrong-length suffix", async () => {
        await expect(
            findByJellyfinTrackId("jellyfin:short")
        ).rejects.toThrow();
    });

    it("accepts upper- and lower-case hex", async () => {
        ops.findUnique.mockResolvedValue(null);
        await expect(
            findByJellyfinTrackId(
                "jellyfin:ABCDEF0123456789abcdef0123456789"
            )
        ).resolves.toBeNull();
    });
});

describe("findByJellyfinTrackId", () => {
    it("queries Prisma with the correct where clause", async () => {
        ops.findUnique.mockResolvedValue({ jellyfinTrackId: VALID_ID });
        const result = await findByJellyfinTrackId(VALID_ID);
        expect(ops.findUnique).toHaveBeenCalledWith({
            where: { jellyfinTrackId: VALID_ID },
        });
        expect(result).toEqual({ jellyfinTrackId: VALID_ID });
    });

    it("propagates a null result when the row doesn't exist", async () => {
        ops.findUnique.mockResolvedValue(null);
        await expect(findByJellyfinTrackId(VALID_ID)).resolves.toBeNull();
    });
});

describe("findManyByJellyfinTrackIds", () => {
    it("returns [] for empty input without hitting Prisma", async () => {
        const result = await findManyByJellyfinTrackIds([]);
        expect(result).toEqual([]);
        expect(ops.findMany).not.toHaveBeenCalled();
    });

    it("validates every id in the input", async () => {
        await expect(
            findManyByJellyfinTrackIds([VALID_ID, "not-a-jellyfin-id"])
        ).rejects.toThrow(/jellyfinTrackId must be in/);
        expect(ops.findMany).not.toHaveBeenCalled();
    });

    it("issues a single findMany with the in clause", async () => {
        ops.findMany.mockResolvedValue([
            { jellyfinTrackId: VALID_ID },
            { jellyfinTrackId: ANOTHER_VALID_ID },
        ]);
        const result = await findManyByJellyfinTrackIds([
            VALID_ID,
            ANOTHER_VALID_ID,
        ]);
        expect(ops.findMany).toHaveBeenCalledTimes(1);
        expect(ops.findMany).toHaveBeenCalledWith({
            where: {
                jellyfinTrackId: { in: [VALID_ID, ANOTHER_VALID_ID] },
            },
        });
        expect(result).toHaveLength(2);
    });
});

describe("markAudioAnalysisStarted", () => {
    it("upserts to status='processing' and stamps a start time", async () => {
        ops.upsert.mockResolvedValue({
            jellyfinTrackId: VALID_ID,
            analysisStatus: "processing",
        });
        await markAudioAnalysisStarted(VALID_ID);

        expect(ops.upsert).toHaveBeenCalledTimes(1);
        const call = ops.upsert.mock.calls[0][0];
        expect(call.where).toEqual({ jellyfinTrackId: VALID_ID });
        expect(call.create.analysisStatus).toBe("processing");
        expect(call.create.analysisStartedAt).toBeInstanceOf(Date);
        expect(call.update.analysisStatus).toBe("processing");
        expect(call.update.analysisStartedAt).toBeInstanceOf(Date);
        expect(call.update.analysisError).toBeNull();
    });
});

describe("recordAudioAnalysisCompleted", () => {
    it("writes only the fields the caller passed; leaves others alone", async () => {
        ops.upsert.mockResolvedValue({});
        await recordAudioAnalysisCompleted(VALID_ID, {
            bpm: 128.4,
            energy: 0.72,
            moodTags: ["uplifting", "driving"],
            analysisVersion: "1.4.0",
        });

        const call = ops.upsert.mock.calls[0][0];
        expect(call.update).toMatchObject({
            analysisStatus: "completed",
            analysisError: null,
            analysisRetryCount: 0,
            bpm: 128.4,
            energy: 0.72,
            moodTags: ["uplifting", "driving"],
            analysisVersion: "1.4.0",
        });
        expect(call.update.analyzedAt).toBeInstanceOf(Date);
        // valence not in payload → must be omitted from the update set
        // (Prisma reads `undefined` as "leave alone").
        expect(call.update).not.toHaveProperty("valence");
        expect(call.update).not.toHaveProperty("danceability");
    });

    it("preserves null payload values as explicit nulls (clearing prior data)", async () => {
        ops.upsert.mockResolvedValue({});
        await recordAudioAnalysisCompleted(VALID_ID, {
            bpm: null,
            keyScale: null,
        });
        const call = ops.upsert.mock.calls[0][0];
        expect(call.update.bpm).toBeNull();
        expect(call.update.keyScale).toBeNull();
    });

    it("writes empty arrays when caller explicitly passes []", async () => {
        ops.upsert.mockResolvedValue({});
        await recordAudioAnalysisCompleted(VALID_ID, {
            moodTags: [],
            essentiaGenres: [],
        });
        const call = ops.upsert.mock.calls[0][0];
        expect(call.update.moodTags).toEqual([]);
        expect(call.update.essentiaGenres).toEqual([]);
    });
});

describe("recordAudioAnalysisFailed", () => {
    it("sets failed status and increments retry counter on update", async () => {
        ops.upsert.mockResolvedValue({});
        await recordAudioAnalysisFailed(VALID_ID, "ffmpeg crashed");

        const call = ops.upsert.mock.calls[0][0];
        expect(call.create.analysisStatus).toBe("failed");
        expect(call.create.analysisRetryCount).toBe(1);
        expect(call.update.analysisStatus).toBe("failed");
        expect(call.update.analysisRetryCount).toEqual({ increment: 1 });
    });

    it("truncates very long error messages", async () => {
        ops.upsert.mockResolvedValue({});
        const huge = "x".repeat(5000);
        await recordAudioAnalysisFailed(VALID_ID, huge);
        const call = ops.upsert.mock.calls[0][0];
        expect((call.update.analysisError as string).length).toBe(1000);
    });
});

describe("resetAudioAnalysisToPending", () => {
    it("returns null and skips update when no row exists", async () => {
        ops.findUnique.mockResolvedValue(null);
        const result = await resetAudioAnalysisToPending(VALID_ID);
        expect(result).toBeNull();
        expect(ops.update).not.toHaveBeenCalled();
    });

    it("clears error and start time on existing rows", async () => {
        ops.findUnique.mockResolvedValue({
            jellyfinTrackId: VALID_ID,
            analysisStatus: "failed",
        });
        ops.update.mockResolvedValue({});
        await resetAudioAnalysisToPending(VALID_ID);

        expect(ops.update).toHaveBeenCalledWith({
            where: { jellyfinTrackId: VALID_ID },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisStartedAt: null,
            },
        });
    });
});

describe("setVibeAnalysisStatus", () => {
    it("stamps vibeAnalysisStartedAt when transitioning to processing", async () => {
        ops.upsert.mockResolvedValue({});
        await setVibeAnalysisStatus(VALID_ID, "processing");

        const call = ops.upsert.mock.calls[0][0];
        expect(call.update.vibeAnalysisStatus).toBe("processing");
        expect(call.update.vibeAnalysisStartedAt).toBeInstanceOf(Date);
        expect(call.update.vibeAnalysisStatusUpdatedAt).toBeInstanceOf(Date);
    });

    it("does NOT overwrite vibeAnalysisStartedAt when transitioning to completed", async () => {
        ops.upsert.mockResolvedValue({});
        await setVibeAnalysisStatus(VALID_ID, "completed");

        const call = ops.upsert.mock.calls[0][0];
        expect(call.update.vibeAnalysisStatus).toBe("completed");
        expect(call.update).not.toHaveProperty("vibeAnalysisStartedAt");
    });

    it("records error message + bumps retry counter when bumpRetry=true", async () => {
        ops.upsert.mockResolvedValue({});
        await setVibeAnalysisStatus(VALID_ID, "failed", {
            error: "embedding timed out",
            bumpRetry: true,
        });

        const call = ops.upsert.mock.calls[0][0];
        expect(call.update.vibeAnalysisStatus).toBe("failed");
        expect(call.update.vibeAnalysisError).toBe("embedding timed out");
        expect(call.update.vibeAnalysisRetryCount).toEqual({ increment: 1 });
    });

    it("does not increment retry when bumpRetry is omitted", async () => {
        ops.upsert.mockResolvedValue({});
        await setVibeAnalysisStatus(VALID_ID, "completed");

        const call = ops.upsert.mock.calls[0][0];
        expect(call.update).not.toHaveProperty("vibeAnalysisRetryCount");
    });

    it("explicitly clears error when null is passed", async () => {
        ops.upsert.mockResolvedValue({});
        await setVibeAnalysisStatus(VALID_ID, "completed", { error: null });

        const call = ops.upsert.mock.calls[0][0];
        expect(call.update.vibeAnalysisError).toBeNull();
    });

    it("leaves error untouched when not passed at all", async () => {
        ops.upsert.mockResolvedValue({});
        await setVibeAnalysisStatus(VALID_ID, "processing");

        const call = ops.upsert.mock.calls[0][0];
        expect(call.update).not.toHaveProperty("vibeAnalysisError");
    });
});

describe("getAudioAnalysisStatusCounts", () => {
    it("returns all four buckets even when some are absent from the groupBy result", async () => {
        ops.groupBy.mockResolvedValue([
            { analysisStatus: "completed", _count: 5 },
            { analysisStatus: "failed", _count: 2 },
        ]);
        const result = await getAudioAnalysisStatusCounts();
        expect(result).toEqual({
            pending: 0,
            processing: 0,
            completed: 5,
            failed: 2,
        });
    });

    it("ignores unknown status values defensively", async () => {
        ops.groupBy.mockResolvedValue([
            { analysisStatus: "completed", _count: 5 },
            { analysisStatus: "weird-future-status", _count: 99 },
        ]);
        const result = await getAudioAnalysisStatusCounts();
        expect(result.completed).toBe(5);
        expect(result.pending).toBe(0);
        expect(result.processing).toBe(0);
        expect(result.failed).toBe(0);
    });
});
