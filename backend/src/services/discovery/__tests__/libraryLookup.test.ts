import {
    buildJellyfinTrackIndex,
    JellyfinLibraryEntry,
} from "../../jellyfinLibraryIndex";

jest.mock("../../jellyfin", () => ({
    isJellyfinMusicSource: jest.fn(),
}));
jest.mock("../../jellyfinLibraryIndex", () => {
    const actual = jest.requireActual("../../jellyfinLibraryIndex");
    return { ...actual, loadJellyfinTrackIndex: jest.fn() };
});
jest.mock("../../../utils/db", () => ({
    prisma: {
        track: { findMany: jest.fn() },
        album: { findMany: jest.fn(), findFirst: jest.fn() },
        artist: { findFirst: jest.fn() },
    },
}));

import { prisma } from "../../../utils/db";
import { isJellyfinMusicSource } from "../../jellyfin";
import { loadJellyfinTrackIndex } from "../../jellyfinLibraryIndex";
import { invalidateLibraryCache, openLibraryReader } from "../libraryLookup";

const asMock = (fn: unknown) => fn as jest.Mock;

function entry(
    overrides: Partial<JellyfinLibraryEntry> & { trackTitle: string }
): JellyfinLibraryEntry {
    return {
        jellyfinId: `jellyfin:${overrides.trackTitle.replace(/\s+/g, "-")}`,
        artistName: "Doom Regulator",
        trackArtists: [],
        albumTitle: "Skanking Hard",
        rgMbid: null,
        ...overrides,
    };
}

/** Put the module in Jellyfin mode with the given library. */
async function readerFor(entries: JellyfinLibraryEntry[]) {
    invalidateLibraryCache();
    asMock(isJellyfinMusicSource).mockResolvedValue(true);
    asMock(loadJellyfinTrackIndex).mockResolvedValue(
        buildJellyfinTrackIndex(entries)
    );
    return openLibraryReader({ fresh: true });
}

beforeEach(() => {
    jest.clearAllMocks();
    invalidateLibraryCache();
});

describe("openLibraryReader", () => {
    it("reads the scan tables when Jellyfin is not the music source", async () => {
        asMock(isJellyfinMusicSource).mockResolvedValue(false);

        const reader = await openLibraryReader();

        expect(reader.isJellyfin).toBe(false);
        expect(loadJellyfinTrackIndex).not.toHaveBeenCalled();
    });

    it("reuses a loaded Jellyfin index across reads", async () => {
        asMock(isJellyfinMusicSource).mockResolvedValue(true);
        asMock(loadJellyfinTrackIndex).mockResolvedValue(
            buildJellyfinTrackIndex([entry({ trackTitle: "Raid" })])
        );

        await openLibraryReader();
        await openLibraryReader();

        // Ownership is asked hundreds of times per run; re-reading the table
        // for each would dominate generation.
        expect(loadJellyfinTrackIndex).toHaveBeenCalledTimes(1);
    });

    it("reloads when the caller needs music downloaded moments ago", async () => {
        asMock(isJellyfinMusicSource).mockResolvedValue(true);
        asMock(loadJellyfinTrackIndex).mockResolvedValue(
            buildJellyfinTrackIndex([entry({ trackTitle: "Raid" })])
        );

        await openLibraryReader();
        await openLibraryReader({ fresh: true });

        expect(loadJellyfinTrackIndex).toHaveBeenCalledTimes(2);
    });
});

describe("findAlbumTracks against Jellyfin", () => {
    it("returns every track of an album matched by release MBID", async () => {
        const reader = await readerFor([
            entry({ trackTitle: "Raid", rgMbid: "rg-1" }),
            entry({ trackTitle: "Skank Attack", rgMbid: "rg-1" }),
            entry({
                trackTitle: "Unrelated",
                albumTitle: "Other",
                rgMbid: "rg-2",
            }),
        ]);

        const found = await reader.findAlbumTracks([
            {
                artistName: "Doom Regulator",
                albumTitle: "Skanking Hard",
                albumMbid: "rg-1",
            },
        ]);

        expect(found.map((t) => t.title).sort()).toEqual([
            "Raid",
            "Skank Attack",
        ]);
    });

    it("falls back to artist and album title when Jellyfin recorded no MBID", async () => {
        const reader = await readerFor([
            entry({ trackTitle: "Raid" }),
            entry({ trackTitle: "Skank Attack" }),
        ]);

        const found = await reader.findAlbumTracks([
            {
                artistName: "Doom Regulator",
                albumTitle: "Skanking Hard",
                albumMbid: "rg-not-in-library",
            },
        ]);

        expect(found).toHaveLength(2);
    });

    it("carries the requested MBID so one album makes one DiscoveryAlbum", async () => {
        const reader = await readerFor([
            entry({ trackTitle: "Raid" }),
            entry({ trackTitle: "Skank Attack" }),
        ]);

        const found = await reader.findAlbumTracks([
            {
                artistName: "Doom Regulator",
                albumTitle: "Skanking Hard",
                albumMbid: "rg-requested",
            },
        ]);

        // DiscoveryAlbum keys on rgMbid, so both tracks must agree on it.
        expect(found.map((t) => t.album.rgMbid)).toEqual([
            "rg-requested",
            "rg-requested",
        ]);
        expect(new Set(found.map((t) => t.album.id)).size).toBe(1);
    });

    it("synthesizes an album MBID when neither side has one", async () => {
        const reader = await readerFor([entry({ trackTitle: "Raid" })]);

        const found = await reader.findAlbumTracks([
            {
                artistName: "Doom Regulator",
                albumTitle: "Skanking Hard",
                albumMbid: "",
            },
        ]);

        // The column is required, so a stable stand-in is needed rather than
        // dropping the track.
        expect(found[0].album.rgMbid).toBe(
            "album:doom regulator:skanking hard"
        );
    });

    it("reports nothing for an album that is not in the library", async () => {
        const reader = await readerFor([entry({ trackTitle: "Raid" })]);

        const found = await reader.findAlbumTracks([
            {
                artistName: "Some Other Band",
                albumTitle: "Never Downloaded",
                albumMbid: "rg-missing",
            },
        ]);

        expect(found).toEqual([]);
    });

    it("uses the Jellyfin id, which is what playback needs", async () => {
        const reader = await readerFor([
            entry({ trackTitle: "Raid", jellyfinId: "jellyfin:abc123" }),
        ]);

        const found = await reader.findAlbumTracks([
            {
                artistName: "Doom Regulator",
                albumTitle: "Skanking Hard",
                albumMbid: "",
            },
        ]);

        expect(found[0].id).toBe("jellyfin:abc123");
        // Jellyfin exposes no filesystem path.
        expect(found[0].filePath).toBe("");
    });
});

describe("findTracks against Jellyfin", () => {
    it("matches a song acquired in track-first mode", async () => {
        const reader = await readerFor([entry({ trackTitle: "Raid" })]);

        const found = await reader.findTracks([
            { artistName: "Doom Regulator", trackTitle: "Raid" },
        ]);

        expect(found).toHaveLength(1);
        expect(found[0].title).toBe("Raid");
    });

    it("finds a track credited to its performer on a compilation", async () => {
        const reader = await readerFor([
            entry({
                trackTitle: "Raid",
                artistName: "Various Artists",
                trackArtists: ["Doom Regulator"],
                albumTitle: "Ska Compilation Vol. 3",
            }),
        ]);

        const found = await reader.findTracks([
            { artistName: "Doom Regulator", trackTitle: "Raid" },
        ]);

        expect(found).toHaveLength(1);
    });

    it("skips a song that is genuinely absent", async () => {
        const reader = await readerFor([entry({ trackTitle: "Raid" })]);

        const found = await reader.findTracks([
            { artistName: "Doom Regulator", trackTitle: "Not Downloaded" },
        ]);

        expect(found).toEqual([]);
    });
});

describe("ownership against Jellyfin", () => {
    it("recognises an artist in the library", async () => {
        const reader = await readerFor([entry({ trackTitle: "Raid" })]);

        await expect(reader.isArtistOwned("Doom Regulator")).resolves.toBe(
            true
        );
        await expect(reader.isArtistOwned("Never Heard Of Them")).resolves.toBe(
            false
        );
    });

    it("recognises an artist despite a leading article", async () => {
        const reader = await readerFor([
            entry({ trackTitle: "Redlight", artistName: "The Slackers" }),
        ]);

        await expect(reader.isArtistOwned("Slackers")).resolves.toBe(true);
    });

    it("recognises an album in the library", async () => {
        const reader = await readerFor([
            entry({ trackTitle: "Raid", rgMbid: "rg-1" }),
        ]);

        await expect(
            reader.isAlbumOwned("Doom Regulator", "Skanking Hard", "rg-1")
        ).resolves.toBe(true);
        await expect(
            reader.isAlbumOwned("Doom Regulator", "Some Other Album", "rg-9")
        ).resolves.toBe(false);
    });

    it("treats an empty library as owning nothing rather than everything", async () => {
        const reader = await readerFor([]);

        expect(reader.size).toBe(0);
        await expect(reader.isArtistOwned("Doom Regulator")).resolves.toBe(
            false
        );
    });
});

describe("the native reader", () => {
    beforeEach(() => {
        asMock(isJellyfinMusicSource).mockResolvedValue(false);
    });

    it("prefers the release MBID when looking for an album's tracks", async () => {
        asMock(prisma.track.findMany).mockResolvedValue([
            { id: "t1", title: "Raid" },
        ]);

        const reader = await openLibraryReader();
        await reader.findAlbumTracks([
            {
                artistName: "Doom Regulator",
                albumTitle: "Skanking Hard",
                albumMbid: "rg-1",
            },
        ]);

        expect(asMock(prisma.track.findMany).mock.calls[0][0].where).toEqual({
            album: { rgMbid: "rg-1" },
        });
    });

    it("does not count an artist with no albums as owned", async () => {
        // The Jellyfin bridge creates artist rows without albums; treating
        // those as owned would suppress recommendations for them.
        asMock(prisma.artist.findFirst).mockResolvedValue({
            id: "a1",
            albums: [],
        });

        const reader = await openLibraryReader();

        await expect(
            reader.isArtistOwned("Doom Regulator", "mbid-1")
        ).resolves.toBe(false);
    });

    it("counts an artist holding at least one album as owned", async () => {
        asMock(prisma.artist.findFirst).mockResolvedValue({
            id: "a1",
            albums: [{ id: "al1" }],
        });

        const reader = await openLibraryReader();

        await expect(reader.isArtistOwned("Doom Regulator")).resolves.toBe(
            true
        );
    });
});
