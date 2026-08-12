import type { Job } from "bullmq";
import { processScan, type ScanJobData } from "../scanProcessor";

const buildPlaylistAfterScan = jest.fn();
const buildFinalPlaylist = jest.fn();
const isJellyfinMusicSource = jest.fn();

jest.mock("../../../services/musicScanner", () => ({
    MusicScannerService: jest.fn().mockImplementation(() => ({
        scanLibrary: jest.fn(async () => ({
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksRemoved: 0,
            errors: [],
            duration: 0,
        })),
    })),
}));

jest.mock("../../../services/spotifyImport", () => ({
    spotifyImportService: {
        buildPlaylistAfterScan: (...args: unknown[]) =>
            buildPlaylistAfterScan(...args),
    },
}));

jest.mock("../../../services/discoverWeekly", () => ({
    discoverWeeklyService: {
        buildFinalPlaylist: (...args: unknown[]) => buildFinalPlaylist(...args),
    },
}));

jest.mock("../../../services/jellyfin", () => ({
    isJellyfinMusicSource: () => isJellyfinMusicSource(),
    getJellyfinConfig: jest.fn(async () => null),
    triggerJellyfinLibraryRefresh: jest.fn(),
    waitForJellyfinLibraryScan: jest.fn(),
}));

jest.mock("../../../services/jellyfinMetadataSync", () => ({
    syncRecentJellyfinTracks: jest.fn(async () => ({ synced: 0 })),
    refreshJellyfinRgMbidCache: jest.fn(async () => ({
        processed: 0,
        cached: 0,
        skipped: 0,
    })),
}));

function scanJob(data: ScanJobData): Job<ScanJobData> {
    return {
        id: "scan-1",
        data,
        updateProgress: jest.fn(),
    } as unknown as Job<ScanJobData>;
}

describe("processScan", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        isJellyfinMusicSource.mockResolvedValue(true);
    });

    describe("when Jellyfin is the music source", () => {
        // There is nothing to scan locally, but whoever queued the scan is
        // waiting on it. Returning early left every import that needed a
        // download parked at "scanning" with no playlist, forever.
        it("still builds the playlist for the import that queued it", async () => {
            await processScan(
                scanJob({
                    userId: "user-1",
                    source: "spotify-import",
                    spotifyImportJobId: "import_123",
                })
            );

            expect(buildPlaylistAfterScan).toHaveBeenCalledWith("import_123");
        });

        it("still builds the Discovery Weekly playlist", async () => {
            await processScan(
                scanJob({
                    userId: "user-1",
                    source: "discover-weekly-completion",
                    discoveryBatchId: "batch_1",
                })
            );

            expect(buildFinalPlaylist).toHaveBeenCalledWith("batch_1");
        });

        it("builds nothing for a scan queued by neither", async () => {
            await processScan(
                scanJob({ userId: "user-1", source: "lidarr-webhook" })
            );

            expect(buildPlaylistAfterScan).not.toHaveBeenCalled();
            expect(buildFinalPlaylist).not.toHaveBeenCalled();
        });

        it("does not let a failed playlist build fail the scan", async () => {
            buildPlaylistAfterScan.mockRejectedValueOnce(new Error("boom"));

            await expect(
                processScan(
                    scanJob({
                        userId: "user-1",
                        source: "spotify-import",
                        spotifyImportJobId: "import_123",
                    })
                )
            ).resolves.toBeDefined();
        });
    });
});
