import {
    matchTopTracks,
    normalizeAlbumTitle,
    topTracksFromJellyfin,
    transformJellyfinAlbums,
} from "../artistDetailHelpers";
import type { ResolvedAlbum, ResolvedTrack } from "../../../services/jellyfin";

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

    it("emits a preview-shaped track when Last.fm has no Jellyfin counterpart", () => {
        const lfm = [
            {
                name: "B-Side That Lidifin Doesn't Have",
                playcount: "10",
                listeners: "5",
                duration: "180000", // ms in Last.fm payload
                album: { "#text": "Some Compilation" },
            },
        ];
        const result = matchTopTracks(lfm, [], new Map(), "the-hold-steady");

        expect(result).toHaveLength(1);
        expect(result[0].id).toMatch(/^lastfm-/);
        expect(result[0].album.id).toBeUndefined(); // critical: PREVIEW badge appears
        expect(result[0].album.title).toBe("Some Compilation");
        expect(result[0].duration).toBe(180); // ms → s conversion
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
});
