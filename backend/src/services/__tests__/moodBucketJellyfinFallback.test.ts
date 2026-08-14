import { MOOD_CONFIG, moodBucketService } from "../moodBucketService";

jest.mock("../../utils/db", () => ({
    prisma: {
        jellyfinTrackAnalysis: { findMany: jest.fn() },
        jellyfinTrackMetadata: { findMany: jest.fn() },
    },
}));

jest.mock("../jellyfin", () => ({
    isJellyfinMusicSource: jest.fn(),
    resolveTrackReferences: jest.fn(),
}));

jest.mock("../../utils/shuffle", () => ({
    shuffleArray: <T,>(items: T[]) => items,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { prisma } from "../../utils/db";
import { isJellyfinMusicSource, resolveTrackReferences } from "../jellyfin";

const analysisFindMany = prisma.jellyfinTrackAnalysis
    .findMany as jest.MockedFunction<typeof prisma.jellyfinTrackAnalysis.findMany>;
const metadataFindMany = prisma.jellyfinTrackMetadata
    .findMany as jest.MockedFunction<
    typeof prisma.jellyfinTrackMetadata.findMany
>;
const mockedResolve = resolveTrackReferences as jest.MockedFunction<
    typeof resolveTrackReferences
>;

function taggedTracks(count: number) {
    return Array.from({ length: count }, (_, i) => ({
        jellyfinId: `jf-${i}`,
    }));
}

describe("moodBucketService.getMoodMix (Jellyfin, no Essentia analysis)", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (isJellyfinMusicSource as jest.Mock).mockResolvedValue(true);
        // The production image ships without the Essentia analyzer, so no
        // Jellyfin track ever reaches "completed".
        analysisFindMany.mockResolvedValue([]);
        mockedResolve.mockImplementation(async (ids: string[]) =>
            ids.map((id) => ({
                id,
                album: { coverArt: `cover-${id}` },
            })) as never
        );
    });

    it("builds a mix from Last.fm mood tags", async () => {
        metadataFindMany.mockResolvedValue(taggedTracks(20) as never);

        const mix = await moodBucketService.getMoodMix("happy", 10);

        expect(mix).not.toBeNull();
        expect(mix?.trackIds).toHaveLength(10);
        expect(mix?.mood).toBe("happy");
        expect(mix?.coverUrls).toHaveLength(4);
    });

    it("matches the mood's tag keywords and skips sentinel tags", async () => {
        metadataFindMany.mockResolvedValue(taggedTracks(20) as never);

        await moodBucketService.getMoodMix("melancholy", 10);

        const where = metadataFindMany.mock.calls[0][0]?.where as {
            AND: Record<string, unknown>[];
        };
        expect(where.AND[0]).toEqual({
            lastfmTags: { hasSome: [...MOOD_CONFIG.melancholy.moodTagKeywords] },
        });
        expect(where.AND).toEqual(
            expect.arrayContaining([
                { NOT: { lastfmTags: { has: "_no_mood_tags" } } },
                { NOT: { lastfmTags: { has: "_not_found" } } },
            ])
        );
    });

    it("returns null when tags cannot fill a mix either", async () => {
        metadataFindMany.mockResolvedValue(taggedTracks(3) as never);

        await expect(moodBucketService.getMoodMix("energetic", 10)).resolves.toBeNull();
        expect(mockedResolve).not.toHaveBeenCalled();
    });
});
