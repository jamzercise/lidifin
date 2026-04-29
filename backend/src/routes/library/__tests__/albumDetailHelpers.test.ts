import {
    albumWireShapeFromJellyfin,
    getAlbumArtistsFromJellyfinItem,
    isCompilationAlbumFromArtists,
    normalizeAlbumArtistName,
    type JellyfinAlbumItemShape,
} from "../albumDetailHelpers";
import type { JellyfinConfig, ResolvedTrack } from "../../../services/jellyfin";

const cfg: JellyfinConfig = {
    enabled: true,
    url: "https://jf.example.test",
    apiKey: "key-123",
    userId: "user-abc",
};

function track(id: string, title: string): ResolvedTrack {
    return {
        id,
        title,
        duration: 200,
        artist: { id: "jellyfin:art-1", name: "The Hold Steady" },
        album: {
            id: "jellyfin:alb-1",
            title: "Stay Positive",
            coverArt: null,
        },
    };
}

describe("normalizeAlbumArtistName", () => {
    it("lowercases and strips punctuation", () => {
        expect(normalizeAlbumArtistName("The Hold Steady!")).toBe(
            "the hold steady"
        );
    });

    it("collapses whitespace", () => {
        expect(normalizeAlbumArtistName("  Various   Artists  ")).toBe(
            "various artists"
        );
    });

    it("returns empty string on null/undefined/empty", () => {
        expect(normalizeAlbumArtistName(null)).toBe("");
        expect(normalizeAlbumArtistName(undefined)).toBe("");
        expect(normalizeAlbumArtistName("")).toBe("");
    });
});

describe("getAlbumArtistsFromJellyfinItem", () => {
    it("maps credits with the jellyfin: id prefix", () => {
        const item: JellyfinAlbumItemShape = {
            Id: "abc",
            Name: "Stay Positive",
            Type: "MusicAlbum",
            AlbumArtists: [
                { Id: "art-1", Name: "The Hold Steady" },
                { Id: "art-2", Name: "Craig Finn" },
            ],
        };
        expect(getAlbumArtistsFromJellyfinItem(item)).toEqual([
            { id: "jellyfin:art-1", name: "The Hold Steady" },
            { id: "jellyfin:art-2", name: "Craig Finn" },
        ]);
    });

    it("filters out malformed credit entries", () => {
        const item: JellyfinAlbumItemShape = {
            Id: "abc",
            Name: "x",
            Type: "MusicAlbum",
            AlbumArtists: [
                { Id: "", Name: "Missing Id" } as { Id: string; Name: string },
                { Id: "art-1", Name: "" } as { Id: string; Name: string },
                { Id: "art-2", Name: "Real Artist" },
            ],
        };
        expect(getAlbumArtistsFromJellyfinItem(item)).toEqual([
            { id: "jellyfin:art-2", name: "Real Artist" },
        ]);
    });

    it("returns [] for missing items / empty credits", () => {
        expect(getAlbumArtistsFromJellyfinItem(undefined)).toEqual([]);
        expect(getAlbumArtistsFromJellyfinItem(null)).toEqual([]);
        expect(
            getAlbumArtistsFromJellyfinItem({
                Id: "x",
                Name: "x",
                Type: "MusicAlbum",
            })
        ).toEqual([]);
    });
});

describe("isCompilationAlbumFromArtists", () => {
    it("returns false for a single artist", () => {
        expect(
            isCompilationAlbumFromArtists([
                { id: "jellyfin:a1", name: "The Hold Steady" },
            ])
        ).toBe(false);
    });

    it("returns false when duplicate spellings normalize to the same name", () => {
        expect(
            isCompilationAlbumFromArtists([
                { id: "jellyfin:a1", name: "The Hold Steady" },
                { id: "jellyfin:a2", name: "The Hold Steady!" },
            ])
        ).toBe(false);
    });

    it("returns true when any credit is a 'various artists' alias", () => {
        expect(
            isCompilationAlbumFromArtists([
                { id: "jellyfin:va", name: "Various Artists" },
            ])
        ).toBe(true);
        expect(
            isCompilationAlbumFromArtists([
                { id: "jellyfin:va", name: "VA" },
            ])
        ).toBe(true);
    });

    it("returns true when there are two or more distinct normalized credits", () => {
        expect(
            isCompilationAlbumFromArtists([
                { id: "jellyfin:a1", name: "Craig Finn" },
                { id: "jellyfin:a2", name: "Tad Kubler" },
            ])
        ).toBe(true);
    });

    it("returns false on empty input", () => {
        expect(isCompilationAlbumFromArtists([])).toBe(false);
    });
});

describe("albumWireShapeFromJellyfin", () => {
    const baseItem: JellyfinAlbumItemShape = {
        Id: "alb-1",
        Name: "Stay Positive",
        Type: "MusicAlbum",
        AlbumArtists: [{ Id: "art-1", Name: "The Hold Steady" }],
        ImageTags: { Primary: "tag-1" },
        ProviderIds: {
            MusicBrainzReleaseGroup: "11111111-2222-3333-4444-555555555555",
        },
        ProductionYear: 2008,
    };

    it("produces the canonical owned-album wire shape", () => {
        const result = albumWireShapeFromJellyfin(cfg, baseItem, [
            track("jellyfin:t-1", "Constructive Summer"),
        ]);

        expect(result).toMatchObject({
            id: "jellyfin:alb-1",
            title: "Stay Positive",
            owned: true,
            isCompilation: false,
            year: 2008,
            rgMbid: "11111111-2222-3333-4444-555555555555",
            artist: {
                id: "jellyfin:art-1",
                name: "The Hold Steady",
                mbid: null,
            },
        });
        expect(result.tracks).toHaveLength(1);
        expect(result.coverArt).toBe(result.coverUrl);
        expect(result.coverArt).toContain("/Items/alb-1/Images/Primary");
        expect(result.coverArt).toContain("tag=tag-1");
    });

    it("flags compilations when there are multiple distinct album artists", () => {
        const result = albumWireShapeFromJellyfin(
            cfg,
            {
                ...baseItem,
                AlbumArtists: [
                    { Id: "art-1", Name: "Craig Finn" },
                    { Id: "art-2", Name: "Tad Kubler" },
                ],
            },
            []
        );
        expect(result.isCompilation).toBe(true);
        expect(result.albumArtists).toHaveLength(2);
    });

    it("uses URL-supplied rgMbid when Jellyfin's ProviderIds don't carry one", () => {
        const result = albumWireShapeFromJellyfin(
            cfg,
            { ...baseItem, ProviderIds: {} },
            [],
            { rgMbidFromUrl: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }
        );
        expect(result.rgMbid).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    });

    it("prefers ProviderIds rgMbid over the URL fallback when both are present", () => {
        const result = albumWireShapeFromJellyfin(cfg, baseItem, [], {
            rgMbidFromUrl: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        });
        expect(result.rgMbid).toBe(
            "11111111-2222-3333-4444-555555555555"
        );
    });

    it("omits rgMbid entirely when neither source provides one", () => {
        const result = albumWireShapeFromJellyfin(
            cfg,
            { ...baseItem, ProviderIds: {} },
            []
        );
        expect(result.rgMbid).toBeUndefined();
    });

    it("omits year when ProductionYear is missing", () => {
        const result = albumWireShapeFromJellyfin(
            cfg,
            { ...baseItem, ProductionYear: null },
            []
        );
        expect(result.year).toBeUndefined();
    });

    it("falls back to an Unknown Artist credit when AlbumArtists is empty", () => {
        const result = albumWireShapeFromJellyfin(
            cfg,
            { ...baseItem, AlbumArtists: [] },
            []
        );
        expect(result.artist).toEqual({
            id: "",
            name: "Unknown Artist",
            mbid: null,
        });
        expect(result.albumArtists).toEqual([
            { id: "", name: "Unknown Artist", mbid: null },
        ]);
        expect(result.isCompilation).toBe(false);
    });
});
