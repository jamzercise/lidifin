import {
    deriveImportTrackRows,
    inFlightDownloadIds,
    unmatchedTrackKey,
    type ImportDownloadJob,
    type ImportPendingTrack,
} from "../importTrackStatus";

function track(
    overrides: Partial<ImportPendingTrack> & Pick<ImportPendingTrack, "title">
): ImportPendingTrack {
    return {
        artist: "Radiohead",
        album: "OK Computer",
        albumMbid: "album-1",
        preMatchedTrackId: null,
        ...overrides,
    };
}

function download(
    overrides: Partial<ImportDownloadJob> & Pick<ImportDownloadJob, "id">
): ImportDownloadJob {
    return {
        status: "pending",
        subject: "Radiohead - OK Computer",
        targetMbid: "album-1",
        error: null,
        metadata: {},
        ...overrides,
    };
}

describe("deriveImportTrackRows", () => {
    it("reports a track that already existed in the library", () => {
        const { tracks, summary } = deriveImportTrackRows({
            pendingTracks: [
                track({ title: "Lucky", preMatchedTrackId: "local-1" }),
            ],
            downloadJobs: [],
        });

        expect(tracks[0].state).toBe("in_library");
        expect(tracks[0].downloadJobId).toBeNull();
        expect(summary.inLibrary).toBe(1);
    });

    it("follows the album download's status for tracks waiting on it", () => {
        const cases: Array<[string, string]> = [
            ["pending", "queued"],
            ["processing", "downloading"],
            ["completed", "downloaded"],
            ["failed", "download_failed"],
        ];

        for (const [downloadStatus, expected] of cases) {
            const { tracks } = deriveImportTrackRows({
                pendingTracks: [track({ title: "Lucky" })],
                downloadJobs: [download({ id: "d1", status: downloadStatus })],
            });
            expect(tracks[0].state).toBe(expected);
            expect(tracks[0].downloadJobId).toBe("d1");
        }
    });

    it("says a track has no source when nothing was queued for it", () => {
        const { tracks, summary } = deriveImportTrackRows({
            pendingTracks: [track({ title: "Lucky", albumMbid: null })],
            downloadJobs: [],
        });

        expect(tracks[0].state).toBe("no_source");
        expect(tracks[0].downloadJobId).toBeNull();
        expect(summary.unresolved).toBe(1);
    });

    it("matches a download by artist and album when there is no mbid", () => {
        const { tracks } = deriveImportTrackRows({
            pendingTracks: [track({ title: "Lucky", albumMbid: null })],
            downloadJobs: [
                download({
                    id: "d1",
                    status: "processing",
                    targetMbid: null,
                    metadata: {
                        artistName: "Radiohead",
                        albumTitle: "OK Computer",
                    },
                }),
            ],
        });

        expect(tracks[0].state).toBe("downloading");
        expect(tracks[0].downloadJobId).toBe("d1");
    });

    it("counts how many tracks a download covers, so skipping can say so", () => {
        const { tracks } = deriveImportTrackRows({
            pendingTracks: [
                track({ title: "Airbag" }),
                track({ title: "Lucky" }),
                track({ title: "Idioteque", albumMbid: "album-2" }),
            ],
            downloadJobs: [
                download({ id: "d1", status: "processing" }),
                download({ id: "d2", status: "processing", targetMbid: "album-2" }),
            ],
        });

        expect(tracks[0].downloadTrackCount).toBe(2);
        expect(tracks[1].downloadTrackCount).toBe(2);
        expect(tracks[2].downloadTrackCount).toBe(1);
    });

    it("surfaces the download's own progress text as the detail", () => {
        const { tracks } = deriveImportTrackRows({
            pendingTracks: [track({ title: "Lucky" })],
            downloadJobs: [
                download({
                    id: "d1",
                    status: "processing",
                    metadata: { statusText: "Downloading from peer bob" },
                }),
            ],
        });

        expect(tracks[0].detail).toBe("Downloading from peer bob");
    });

    it("explains a failure with the download's error", () => {
        const { tracks } = deriveImportTrackRows({
            pendingTracks: [track({ title: "Lucky" })],
            downloadJobs: [
                download({
                    id: "d1",
                    status: "failed",
                    error: "No candidates responded",
                }),
            ],
        });

        expect(tracks[0].state).toBe("download_failed");
        expect(tracks[0].detail).toBe("No candidates responded");
    });

    it("marks leftovers unmatched once the import is over", () => {
        const { tracks, summary } = deriveImportTrackRows({
            pendingTracks: [track({ title: "Lucky" })],
            downloadJobs: [download({ id: "d1", status: "completed" })],
            unmatchedKeys: new Set([unmatchedTrackKey("Radiohead", "Lucky")]),
            jobFinished: true,
        });

        expect(tracks[0].state).toBe("unmatched");
        expect(tracks[0].detail).toBe(
            "Downloaded but not found in the library scan"
        );
        expect(summary.unresolved).toBe(1);
    });

    it("leaves a library match alone even if it looks like a leftover", () => {
        const { tracks } = deriveImportTrackRows({
            pendingTracks: [
                track({ title: "Lucky", preMatchedTrackId: "local-1" }),
            ],
            downloadJobs: [],
            unmatchedKeys: new Set([unmatchedTrackKey("Radiohead", "Lucky")]),
            jobFinished: true,
        });

        expect(tracks[0].state).toBe("in_library");
    });

    it("ignores leftovers while the import is still running", () => {
        const { tracks } = deriveImportTrackRows({
            pendingTracks: [track({ title: "Lucky" })],
            downloadJobs: [download({ id: "d1", status: "processing" })],
            unmatchedKeys: new Set([unmatchedTrackKey("Radiohead", "Lucky")]),
            jobFinished: false,
        });

        expect(tracks[0].state).toBe("downloading");
    });

    it("totals each state for the header counts", () => {
        const { summary } = deriveImportTrackRows({
            pendingTracks: [
                track({ title: "A", preMatchedTrackId: "local-1" }),
                track({ title: "B", albumMbid: "album-2" }),
                track({ title: "C", albumMbid: "album-3" }),
                track({ title: "D", albumMbid: "album-4" }),
                track({ title: "E", albumMbid: null }),
            ],
            downloadJobs: [
                download({ id: "d2", status: "completed", targetMbid: "album-2" }),
                download({ id: "d3", status: "processing", targetMbid: "album-3" }),
                download({ id: "d4", status: "failed", targetMbid: "album-4" }),
            ],
        });

        expect(summary).toEqual({
            total: 5,
            inLibrary: 1,
            downloaded: 1,
            inFlight: 1,
            failed: 1,
            unresolved: 1,
        });
    });

    it("tolerates metadata that isn't an object", () => {
        const { tracks } = deriveImportTrackRows({
            pendingTracks: [track({ title: "Lucky" })],
            downloadJobs: [download({ id: "d1", metadata: null })],
        });

        expect(tracks[0].state).toBe("queued");
        expect(tracks[0].detail).toBeNull();
    });
});

describe("inFlightDownloadIds", () => {
    it("returns only the downloads still holding the import open", () => {
        const ids = inFlightDownloadIds([
            download({ id: "queued", status: "pending" }),
            download({ id: "running", status: "processing" }),
            download({ id: "done", status: "completed" }),
            download({ id: "broken", status: "failed" }),
        ]);

        expect(ids).toEqual(["queued", "running"]);
    });
});
