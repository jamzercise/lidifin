import {
    collectJellyfinAlbumsForArtistAliases,
    lastfmDurationToSeconds,
    matchTopTracks,
    normalizeAlbumTitle,
    popularTracksPreferLibrary,
    topTracksFromJellyfin,
    transformJellyfinAlbums,
} from "../artistDetailHelpers";
import type {
    JellyfinConfig,
    ResolvedAlbum,
    ResolvedArtist,
    ResolvedTrack,
} from "../../../services/jellyfin";

const ARTIST = { id: "jellyfin:artist-1", name: "The Hold Steady" };

function jfAlbum(overrides: Partial<ResolvedAlbum>): ResolvedAlbum {
    return {
        id: "jellyfin:alb-1",
        title: "Stay Positive",
        coverArt: "https://jellyfin/cover.jpg",
        artist: ARTIST,
        year: 2008,
        rgMbid: undefined,
        ...overrides,
    };
}

function jfTrack(overrides: Partial<ResolvedTrack>): ResolvedTrack {
    return {
        id: "jellyfin:trk-1",
        title: "Constructive Summer",
        duration: 240,
        artist: ARTIST,
        album: {
            id: "jellyfin:alb-1",
            title: "Stay Positive",
            coverArt: "https://jellyfin/cover.jpg",
        },
        ...overrides,
    };
}

describe("normalizeAlbumTitle", () => {
    it("lowercases, strips punctuation, collapses whitespace", () => {
        expect(normalizeAlbumTitle("Boys & Girls in America")).toBe(
            "boys girls in america"
        );
        expect(normalizeAlbumTitle("  Stay Positive!  ")).toBe("stay positive");
    });
    it("returns empty string for null/undefined", () => {
        expect(normalizeAlbumTitle(undefined)).toBe("");
        expect(normalizeAlbumTitle(null)).toBe("");
    });
});

describe("transformJellyfinAlbums", () => {
    it("maps Jellyfin albums to the wire shape with owned=true and Jellyfin ids", () => {
        const result = transformJellyfinAlbums(
            [
                jfAlbum({ id: "jellyfin:alb-1", title: "Stay Positive", year: 2008 }),
                jfAlbum({ id: "jellyfin:alb-2", title: "Boys and Girls in America", year: 2006 }),
            ],
            ARTIST
        );
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe("jellyfin:alb-1");
        expect(result[0].owned).toBe(true);
        expect(result[0].source).toBe("jellyfin");
        expect(result[0].rgMbid).toBeNull();
        expect(result[0].coverArt).toBe("https://jellyfin/cover.jpg");
        expect(result[0].coverUrl).toBe("https://jellyfin/cover.jpg");
    });

    it("sorts by year descending; nullish years sink to the bottom", () => {
        const result = transformJellyfinAlbums(
            [
                jfAlbum({ id: "jellyfin:alb-old", title: "Old", year: 2003 }),
                jfAlbum({ id: "jellyfin:alb-new", title: "New", year: 2014 }),
                jfAlbum({ id: "jellyfin:alb-no-year", title: "No Year", year: undefined }),
            ],
            ARTIST
        );
        expect(result.map((a) => a.id)).toEqual([
            "jellyfin:alb-new",
            "jellyfin:alb-old",
            "jellyfin:alb-no-year",
        ]);
    });

    it("falls back to the artist hint when an album lacks artist metadata", () => {
        const result = transformJellyfinAlbums(
            [jfAlbum({ artist: undefined })],
            ARTIST
        );
        expect(result[0].artist).toEqual(ARTIST);
        expect(result[0].artistId).toBe(ARTIST.id);
    });

    it("preserves rgMbid when Jellyfin has tagged it", () => {
        const result = transformJellyfinAlbums(
            [jfAlbum({ rgMbid: "abc-123-def" })],
            ARTIST
        );
        expect(result[0].rgMbid).toBe("abc-123-def");
    });

    it("returns an empty array when given no albums", () => {
        expect(transformJellyfinAlbums([], ARTIST)).toEqual([]);
    });
});

describe("lastfmDurationToSeconds", () => {
    it("treats typical values as seconds (Last.fm API contract)", () => {
        expect(lastfmDurationToSeconds("195")).toBe(195);
        expect(lastfmDurationToSeconds(240)).toBe(240);
    });
    it("treats large values as milliseconds (older/cached payloads)", () => {
        expect(lastfmDurationToSeconds("180000")).toBe(180);
        expect(lastfmDurationToSeconds(240000)).toBe(240);
    });
    it("returns 0 for empty or invalid input", () => {
        expect(lastfmDurationToSeconds(undefined)).toBe(0);
        expect(lastfmDurationToSeconds("")).toBe(0);
    });
});

describe("matchTopTracks", () => {
    it("matches Last.fm tracks against Jellyfin library by lowercased title", () => {
        const lfm = [
            {
                name: "Constructive Summer",
                playcount: "1000",
                listeners: "500",
                duration: "240000",
            },
        ];
        const jf = [jfTrack({ id: "jellyfin:trk-1", title: "Constructive Summer" })];
        const result = matchTopTracks(lfm, jf, new Map(), "the-hold-steady");

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("jellyfin:trk-1"); // Jellyfin id, not lastfm-...
        expect(result[0].album.id).toBe("jellyfin:alb-1"); // critical: PREVIEW badge gates on this
        expect(result[0].playCount).toBe(1000);
        expect(result[0].listeners).toBe(500);
        expect(result[0].duration).toBe(240); // from Jellyfin, in seconds
    });

    it("ignores zero-duration Jellyfin stubs so Last.fm can fall through to preview", () => {
        const lfm = [{ name: "Chips Ahoy!" }];
        const jf = [
            jfTrack({
                id: "jellyfin:stub",
                title: "Chips Ahoy!",
                duration: 0,
            }),
        ];
        const result = matchTopTracks(lfm, jf, new Map(), "x");
        expect(result[0].album.id).toBeUndefined();
    });

    it("uses the first playable Jellyfin track when earlier rows are 0s stubs", () => {
        const lfm = [{ name: "Constructive Summer" }];
        const jf = [
            jfTrack({ id: "jellyfin:stub", title: "Constructive Summer", duration: 0 }),
            jfTrack({ id: "jellyfin:real", title: "Constructive Summer", duration: 200 }),
        ];
        const result = matchTopTracks(lfm, jf, new Map(), "x");
        expect(result[0].id).toBe("jellyfin:real");
        expect(result[0].duration).toBe(200);
    });

    it("emits a preview-shaped track when Last.fm has no Jellyfin counterpart", () => {
        const lfm = [
            {
                name: "B-Side That Lidifin Doesn't Have",
                playcount: "10",
                listeners: "5",
                duration: "180000", // milliseconds in some cached payloads
                album: { "#text": "Some Compilation" },
            },
        ];
        const result = matchTopTracks(lfm, [], new Map(), "the-hold-steady");

        expect(result).toHaveLength(1);
        expect(result[0].id).toMatch(/^lastfm-/);
        expect(result[0].album.id).toBeUndefined(); // critical: PREVIEW badge appears
        expect(result[0].album.title).toBe("Some Compilation");
        expect(result[0].duration).toBe(180);
    });

    it("decorates matched tracks with userPlayCount when present", () => {
        const lfm = [{ name: "Constructive Summer", playcount: "1000", listeners: "500" }];
        const jf = [jfTrack({ id: "jellyfin:trk-1", title: "Constructive Summer" })];
        const userPlays = new Map([["jellyfin:trk-1", 7]]);
        const result = matchTopTracks(lfm, jf, userPlays, "the-hold-steady");
        expect(result[0].userPlayCount).toBe(7);
    });

    it("title matching is case-insensitive", () => {
        const lfm = [{ name: "constructive summer" }];
        const jf = [jfTrack({ title: "Constructive Summer" })];
        const result = matchTopTracks(lfm, jf, new Map(), "the-hold-steady");
        expect(result[0].id).toBe("jellyfin:trk-1");
    });

    it("respects the limit option", () => {
        const lfm = Array.from({ length: 15 }, (_, i) => ({ name: `Track ${i}` }));
        const result = matchTopTracks(lfm, [], new Map(), "x", { limit: 5 });
        expect(result).toHaveLength(5);
    });

    it("preserves Last.fm string fields gracefully when fields are missing", () => {
        const lfm = [{ name: "Mystery Song" }]; // no playcount/listeners/duration
        const result = matchTopTracks(lfm, [], new Map(), "x");
        expect(result[0].playCount).toBe(0);
        expect(result[0].listeners).toBe(0);
        expect(result[0].duration).toBe(0);
        expect(result[0].album.title).toBe("Unknown Album");
    });
});

describe("popularTracksPreferLibrary", () => {
    it("drops Last.fm-only rows and pads from Jellyfin", () => {
        const lfm = [
            { name: "Not In Library" },
            { name: "Constructive Summer" },
        ];
        const jf = [
            jfTrack({ id: "jellyfin:a", title: "Constructive Summer", duration: 200 }),
            jfTrack({ id: "jellyfin:b", title: "Other", duration: 180 }),
            jfTrack({ id: "jellyfin:c", title: "Third", duration: 190 }),
        ];
        const result = popularTracksPreferLibrary(lfm, jf, new Map(), "x", {
            lastfmLimit: 10,
            outputTarget: 3,
        });
        expect(result).toHaveLength(3);
        expect(result.every((t) => t.album?.id)).toBe(true);
        expect(result[0].title).toBe("Constructive Summer");
    });
});

describe("collectJellyfinAlbumsForArtistAliases", () => {
    const cfg = {} as JellyfinConfig;

    function albumOf(id: string, title: string): ResolvedAlbum {
        return {
            id,
            title,
            coverArt: null,
            artist: { id: "jellyfin:any", name: "any" },
        };
    }

    function artistOf(id: string, name: string): ResolvedArtist {
        return { id, name, coverArt: undefined, mbid: undefined };
    }

    it("returns just the primary artist's albums when no aliases produce siblings", async () => {
        const getAlbumsForArtist = jest
            .fn<Promise<ResolvedAlbum[]>, [JellyfinConfig, string]>()
            .mockResolvedValue([albumOf("jellyfin:alb-1", "Stay Positive")]);
        const searchArtists = jest
            .fn<
                Promise<{ artists: ResolvedArtist[]; total: number }>,
                [JellyfinConfig, { search: string; limit: number; offset: number }]
            >()
            .mockResolvedValue({ artists: [], total: 0 });

        const result = await collectJellyfinAlbumsForArtistAliases(
            cfg,
            "jellyfin:primary",
            ["The Hold Steady"],
            { getAlbumsForArtist, searchArtists }
        );

        expect(result).toHaveLength(1);
        expect(getAlbumsForArtist).toHaveBeenCalledTimes(1);
        expect(getAlbumsForArtist).toHaveBeenCalledWith(cfg, "jellyfin:primary");
    });

    it("unions albums from sibling artist records whose normalized name matches an alias", async () => {
        const getAlbumsForArtist = jest
            .fn<Promise<ResolvedAlbum[]>, [JellyfinConfig, string]>()
            .mockImplementation(async (_cfg, id) => {
                if (id === "jellyfin:primary") {
                    return [albumOf("jellyfin:alb-1", "Heaven Is Whenever")];
                }
                if (id === "jellyfin:sibling") {
                    return [
                        albumOf("jellyfin:alb-2", "Stay Positive"),
                        albumOf("jellyfin:alb-3", "Boys and Girls in America"),
                    ];
                }
                return [];
            });
        const searchArtists = jest
            .fn<
                Promise<{ artists: ResolvedArtist[]; total: number }>,
                [JellyfinConfig, { search: string; limit: number; offset: number }]
            >()
            .mockResolvedValue({
                artists: [
                    artistOf("jellyfin:sibling", "Hold Steady"), // sibling for "The Hold Steady"
                    artistOf("jellyfin:other", "Some Other Band"), // ignored
                ],
                total: 2,
            });

        const result = await collectJellyfinAlbumsForArtistAliases(
            cfg,
            "jellyfin:primary",
            ["The Hold Steady", "Hold Steady"],
            { getAlbumsForArtist, searchArtists }
        );

        const ids = result.map((a) => a.id);
        expect(ids).toEqual([
            "jellyfin:alb-1",
            "jellyfin:alb-2",
            "jellyfin:alb-3",
        ]);
    });

    it("dedupes when the same album appears under both primary and sibling records", async () => {
        const getAlbumsForArtist = jest
            .fn<Promise<ResolvedAlbum[]>, [JellyfinConfig, string]>()
            .mockImplementation(async (_cfg, id) => {
                if (id === "jellyfin:primary") {
                    return [albumOf("jellyfin:alb-1", "Stay Positive")];
                }
                return [
                    albumOf("jellyfin:alb-1", "Stay Positive"), // duplicate
                    albumOf("jellyfin:alb-2", "Teeth Dreams"),
                ];
            });
        const searchArtists = jest
            .fn<
                Promise<{ artists: ResolvedArtist[]; total: number }>,
                [JellyfinConfig, { search: string; limit: number; offset: number }]
            >()
            .mockResolvedValue({
                artists: [artistOf("jellyfin:sibling", "Hold Steady")],
                total: 1,
            });

        const result = await collectJellyfinAlbumsForArtistAliases(
            cfg,
            "jellyfin:primary",
            ["The Hold Steady", "Hold Steady"],
            { getAlbumsForArtist, searchArtists }
        );

        expect(result.map((a) => a.id)).toEqual([
            "jellyfin:alb-1",
            "jellyfin:alb-2",
        ]);
    });

    it("doesn't re-fetch the same sibling artist across multiple alias searches", async () => {
        const getAlbumsForArtist = jest
            .fn<Promise<ResolvedAlbum[]>, [JellyfinConfig, string]>()
            .mockResolvedValue([]);
        const searchArtists = jest
            .fn<
                Promise<{ artists: ResolvedArtist[]; total: number }>,
                [JellyfinConfig, { search: string; limit: number; offset: number }]
            >()
            .mockResolvedValue({
                artists: [artistOf("jellyfin:sibling", "Hold Steady")],
                total: 1,
            });

        await collectJellyfinAlbumsForArtistAliases(
            cfg,
            "jellyfin:primary",
            ["The Hold Steady", "Hold Steady", "Hold Steady, The"],
            { getAlbumsForArtist, searchArtists }
        );

        // Primary + sibling = 2 album fetches total, even though 3 alias
        // searches all surface the same sibling.
        expect(getAlbumsForArtist).toHaveBeenCalledTimes(2);
    });

    it("ignores sibling artists whose normalized name doesn't match any alias", async () => {
        const getAlbumsForArtist = jest
            .fn<Promise<ResolvedAlbum[]>, [JellyfinConfig, string]>()
            .mockImplementation(async (_cfg, id) => {
                if (id === "jellyfin:primary") {
                    return [albumOf("jellyfin:alb-1", "Stay Positive")];
                }
                throw new Error(
                    `unexpected fetch for ${id} — alias filter let through a non-match`
                );
            });
        const searchArtists = jest
            .fn<
                Promise<{ artists: ResolvedArtist[]; total: number }>,
                [JellyfinConfig, { search: string; limit: number; offset: number }]
            >()
            .mockResolvedValue({
                artists: [
                    artistOf("jellyfin:wrong-1", "The Holdsteadies"),
                    artistOf("jellyfin:wrong-2", "Steady Hold"),
                ],
                total: 2,
            });

        const result = await collectJellyfinAlbumsForArtistAliases(
            cfg,
            "jellyfin:primary",
            ["The Hold Steady"],
            { getAlbumsForArtist, searchArtists }
        );
        expect(result).toHaveLength(1);
    });

    it("survives a single sibling fetch failure and continues with the rest", async () => {
        const getAlbumsForArtist = jest
            .fn<Promise<ResolvedAlbum[]>, [JellyfinConfig, string]>()
            .mockImplementation(async (_cfg, id) => {
                if (id === "jellyfin:primary") {
                    return [albumOf("jellyfin:alb-1", "Heaven Is Whenever")];
                }
                if (id === "jellyfin:bad") throw new Error("Jellyfin 500");
                if (id === "jellyfin:good") {
                    return [albumOf("jellyfin:alb-2", "Stay Positive")];
                }
                return [];
            });
        const searchArtists = jest
            .fn<
                Promise<{ artists: ResolvedArtist[]; total: number }>,
                [JellyfinConfig, { search: string; limit: number; offset: number }]
            >()
            .mockResolvedValue({
                artists: [
                    artistOf("jellyfin:bad", "Hold Steady"),
                    artistOf("jellyfin:good", "The Hold Steady"),
                ],
                total: 2,
            });

        const result = await collectJellyfinAlbumsForArtistAliases(
            cfg,
            "jellyfin:primary",
            ["The Hold Steady", "Hold Steady"],
            { getAlbumsForArtist, searchArtists }
        );

        expect(result.map((a) => a.id)).toEqual([
            "jellyfin:alb-1",
            "jellyfin:alb-2",
        ]);
    });

    it("returns the primary set unchanged when aliases is empty", async () => {
        const getAlbumsForArtist = jest
            .fn<Promise<ResolvedAlbum[]>, [JellyfinConfig, string]>()
            .mockResolvedValue([albumOf("jellyfin:alb-1", "Stay Positive")]);
        const searchArtists = jest
            .fn<
                Promise<{ artists: ResolvedArtist[]; total: number }>,
                [JellyfinConfig, { search: string; limit: number; offset: number }]
            >()
            .mockResolvedValue({ artists: [], total: 0 });

        const result = await collectJellyfinAlbumsForArtistAliases(
            cfg,
            "jellyfin:primary",
            [],
            { getAlbumsForArtist, searchArtists }
        );
        expect(result).toHaveLength(1);
        expect(searchArtists).not.toHaveBeenCalled();
    });
});

describe("topTracksFromJellyfin", () => {
    it("falls back to library tracks when Last.fm is unavailable", () => {
        const jf = [
            jfTrack({ id: "jellyfin:trk-1", title: "A" }),
            jfTrack({ id: "jellyfin:trk-2", title: "B" }),
        ];
        const result = topTracksFromJellyfin(jf, new Map([["jellyfin:trk-1", 3]]));
        expect(result).toHaveLength(2);
        expect(result[0].id).toBe("jellyfin:trk-1");
        expect(result[0].album.id).toBe("jellyfin:alb-1"); // playable, no PREVIEW
        expect(result[0].userPlayCount).toBe(3);
        expect(result[1].userPlayCount).toBe(0);
    });

    it("respects the limit option", () => {
        const jf = Array.from({ length: 15 }, (_, i) =>
            jfTrack({ id: `jellyfin:trk-${i}`, title: `Track ${i}` })
        );
        const result = topTracksFromJellyfin(jf, new Map(), { limit: 5 });
        expect(result).toHaveLength(5);
    });

    it("handles empty input", () => {
        expect(topTracksFromJellyfin([], new Map())).toEqual([]);
    });

    it("skips zero-duration Jellyfin tracks", () => {
        const jf = [
            jfTrack({ id: "jellyfin:bad", title: "Stub", duration: 0 }),
            jfTrack({ id: "jellyfin:ok", title: "Real", duration: 100 }),
        ];
        const result = topTracksFromJellyfin(jf, new Map());
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("jellyfin:ok");
    });
});
