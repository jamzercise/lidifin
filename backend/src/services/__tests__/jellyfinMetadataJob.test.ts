import { isJobStale, type JellyfinMetadataJobState } from "../jellyfinMetadataJob";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function state(overrides: Partial<JellyfinMetadataJobState> = {}): JellyfinMetadataJobState {
    return { status: "syncing", startedAt: NOW, heartbeatAt: NOW, ...overrides };
}

describe("isJobStale", () => {
    it("leaves an idle job alone", () => {
        expect(isJobStale({ status: "idle" }, NOW)).toBe(false);
    });

    it("keeps a job that is still reporting in", () => {
        expect(isJobStale(state({ heartbeatAt: NOW - MINUTE }), NOW)).toBe(false);
    });

    it("keeps a long-running job alive on its heartbeat alone", () => {
        // A full sync plus enrichment can run for hours; started long ago is
        // not by itself a reason to discard it.
        const long = state({ startedAt: NOW - 5 * 60 * MINUTE, heartbeatAt: NOW - 10_000 });
        expect(isJobStale(long, NOW)).toBe(false);
    });

    it("discards a job that stopped reporting in", () => {
        expect(isJobStale(state({ heartbeatAt: NOW - 5 * MINUTE }), NOW)).toBe(true);
    });

    it("applies the same rule while enriching", () => {
        const enriching = state({ status: "enriching", heartbeatAt: NOW - 5 * MINUTE });
        expect(isJobStale(enriching, NOW)).toBe(true);
    });

    describe("state written before heartbeats existed", () => {
        it("is given an hour to finish", () => {
            const legacy: JellyfinMetadataJobState = {
                status: "syncing",
                startedAt: NOW - 30 * MINUTE,
            };
            expect(isJobStale(legacy, NOW)).toBe(false);
        });

        it("is discarded once that lapses", () => {
            const legacy: JellyfinMetadataJobState = {
                status: "syncing",
                startedAt: NOW - 90 * MINUTE,
            };
            expect(isJobStale(legacy, NOW)).toBe(true);
        });
    });

    it("discards a running job with no timing to judge it by", () => {
        expect(isJobStale({ status: "syncing" }, NOW)).toBe(true);
    });
});
