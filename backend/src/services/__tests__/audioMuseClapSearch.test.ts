import {
    getClapStats,
    getClapTopQueries,
    searchByText,
} from "../audioMuseService";

const post = jest.fn();
const get = jest.fn();
const getSystemSettings = jest.fn();

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        post: (...args: unknown[]) => post(...args),
        get: (...args: unknown[]) => get(...args),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: () => getSystemSettings(),
}));

const ENABLED = {
    audiomuseEnabled: true,
    audiomuseUrl: "http://audiomuse:8000/",
};

describe("searchByText", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getSystemSettings.mockResolvedValue(ENABLED);
    });

    it("returns tracks with AudioMuse's similarity scores", async () => {
        post.mockResolvedValue({
            status: 200,
            data: {
                query: "calm piano",
                count: 2,
                results: [
                    { item_id: "abc", title: "Nocturne", author: "Chopin", similarity: 0.91 },
                    { item_id: "def", title: "Gymnopedie", author: "Satie", similarity: 0.84 },
                ],
            },
        });

        const result = await searchByText("calm piano", 10);

        expect(result.error).toBeUndefined();
        expect(result.tracks).toEqual([
            { itemId: "abc", title: "Nocturne", author: "Chopin", similarity: 0.91 },
            { itemId: "def", title: "Gymnopedie", author: "Satie", similarity: 0.84 },
        ]);
    });

    it("posts to the clap search endpoint with a trailing-slash-safe URL", async () => {
        post.mockResolvedValue({ status: 200, data: { results: [] } });

        await searchByText("  moody jazz  ", 25);

        expect(post).toHaveBeenCalledWith(
            "http://audiomuse:8000/api/clap/search",
            { query: "moody jazz", limit: 25 },
            expect.objectContaining({ timeout: 60000 })
        );
    });

    it("clamps the limit to AudioMuse's accepted range", async () => {
        post.mockResolvedValue({ status: 200, data: { results: [] } });

        await searchByText("anything", 9000);

        expect(post).toHaveBeenCalledWith(
            expect.any(String),
            { query: "anything", limit: 500 },
            expect.anything()
        );
    });

    it("reports a cold cache as its own reason so callers can tell the user to analyze", async () => {
        post.mockResolvedValue({ status: 503, data: {} });

        const result = await searchByText("calm piano");

        expect(result.reason).toBe("cache-cold");
        expect(result.error).toMatch(/analyz/i);
        expect(result.tracks).toEqual([]);
    });

    it("distinguishes CLAP being switched off from a bad query", async () => {
        post.mockResolvedValue({
            status: 400,
            data: { error: "CLAP text search is disabled. Set CLAP_ENABLED=true in config." },
        });

        const disabled = await searchByText("calm piano");
        expect(disabled.reason).toBe("disabled");

        post.mockResolvedValue({ status: 400, data: { error: "Query cannot be empty" } });

        const badQuery = await searchByText("calm piano");
        expect(badQuery.reason).toBe("failed");
    });

    it("reports an unreachable AudioMuse without throwing", async () => {
        post.mockRejectedValue({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" });

        const result = await searchByText("calm piano");

        expect(result.reason).toBe("unreachable");
        expect(result.tracks).toEqual([]);
    });

    it("skips results missing an item id", async () => {
        post.mockResolvedValue({
            status: 200,
            data: { results: [{ title: "Orphan" }, { item_id: "ok", similarity: 0.5 }] },
        });

        const result = await searchByText("calm piano");

        expect(result.tracks).toHaveLength(1);
        expect(result.tracks[0].itemId).toBe("ok");
    });

    it("returns not-configured when AudioMuse is off, without calling out", async () => {
        getSystemSettings.mockResolvedValue({ audiomuseEnabled: false });

        const result = await searchByText("calm piano");

        expect(result.reason).toBe("not-configured");
        expect(post).not.toHaveBeenCalled();
    });
});

describe("getClapStats", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getSystemSettings.mockResolvedValue(ENABLED);
    });

    // Payload copied from a live AudioMuse 2.6.2 instance. The endpoint's own
    // OpenAPI docstring advertises num_embeddings, but the handler returns
    // song_count, and reading the documented name reported an empty index.
    it("reads the cache size AudioMuse actually reports", async () => {
        get.mockResolvedValue({
            status: 200,
            data: {
                clap_enabled: true,
                embedding_dimension: 512,
                loaded: true,
                memory_mb: 0.96,
                song_count: 17889,
            },
        });

        const { stats } = await getClapStats();

        expect(stats).toEqual({
            clapEnabled: true,
            numEmbeddings: 17889,
            lastRefresh: null,
        });
    });

    it("falls back to num_embeddings when a build reports that instead", async () => {
        get.mockResolvedValue({
            status: 200,
            data: {
                clap_enabled: true,
                num_embeddings: 4213,
                last_refresh: "2026-08-14T10:00:00Z",
            },
        });

        const { stats } = await getClapStats();

        expect(stats).toEqual({
            clapEnabled: true,
            numEmbeddings: 4213,
            lastRefresh: "2026-08-14T10:00:00Z",
        });
    });

    it("reports an empty index as zero rather than NaN", async () => {
        get.mockResolvedValue({
            status: 200,
            data: { clap_enabled: true, loaded: false, song_count: 0 },
        });

        const { stats } = await getClapStats();

        expect(stats?.numEmbeddings).toBe(0);
    });

    it("honours a caller-supplied timeout", async () => {
        get.mockResolvedValue({ status: 200, data: {} });

        await getClapStats(4000);

        expect(get).toHaveBeenCalledWith(
            "http://audiomuse:8000/api/clap/stats",
            expect.objectContaining({ timeout: 4000 })
        );
    });

    it("returns no stats when AudioMuse cannot be reached", async () => {
        get.mockRejectedValue({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND" });

        const result = await getClapStats();

        expect(result.stats).toBeUndefined();
        expect(result.reason).toBe("unreachable");
    });
});

describe("getClapTopQueries", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getSystemSettings.mockResolvedValue(ENABLED);
    });

    it("returns the suggestion list once AudioMuse says it is ready", async () => {
        get.mockResolvedValue({
            status: 200,
            data: { queries: ["calm piano songs", "driving synthwave"], ready: true },
        });

        const result = await getClapTopQueries();

        expect(result).toEqual({
            queries: ["calm piano songs", "driving synthwave"],
            ready: true,
        });
    });

    it("is not ready when the background computation has not produced anything", async () => {
        get.mockResolvedValue({ status: 200, data: { queries: [], ready: true } });

        const result = await getClapTopQueries();

        expect(result.ready).toBe(false);
    });

    it("degrades quietly when AudioMuse is unavailable", async () => {
        get.mockRejectedValue({ code: "ECONNREFUSED", message: "nope" });

        await expect(getClapTopQueries()).resolves.toEqual({
            queries: [],
            ready: false,
        });
    });
});
