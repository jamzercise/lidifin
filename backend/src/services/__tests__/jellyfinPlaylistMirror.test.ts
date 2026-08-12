import { syncPlaylistToJellyfin } from "../jellyfinPlaylistMirror";

const findUnique = jest.fn();
const update = jest.fn();
const getJellyfinConfig = jest.fn();
const createJellyfinPlaylist = jest.fn();
const addToJellyfinPlaylist = jest.fn();
const getJellyfinPlaylistItems = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        playlist: {
            findUnique: (...args: unknown[]) => findUnique(...args),
            update: (...args: unknown[]) => update(...args),
        },
    },
}));

jest.mock("../jellyfin", () => ({
    getJellyfinConfig: () => getJellyfinConfig(),
    createJellyfinPlaylist: (...args: unknown[]) =>
        createJellyfinPlaylist(...args),
    addToJellyfinPlaylist: (...args: unknown[]) =>
        addToJellyfinPlaylist(...args),
    getJellyfinPlaylistItems: (...args: unknown[]) =>
        getJellyfinPlaylistItems(...args),
}));

const CONFIG = { url: "http://jellyfin", apiKey: "key" };

function playlist(overrides: {
    name?: string;
    jellyfinPlaylistId?: string | null;
    trackIds: string[];
}) {
    return {
        name: overrides.name ?? "Road trip",
        jellyfinPlaylistId: overrides.jellyfinPlaylistId ?? null,
        items: overrides.trackIds.map((trackId) => ({ trackId })),
    };
}

describe("syncPlaylistToJellyfin", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        getJellyfinConfig.mockResolvedValue(CONFIG);
        createJellyfinPlaylist.mockResolvedValue("jf-playlist-1");
        addToJellyfinPlaylist.mockResolvedValue(true);
        getJellyfinPlaylistItems.mockResolvedValue([]);
    });

    it("creates the Jellyfin playlist and records its id", async () => {
        findUnique.mockResolvedValue(
            playlist({ trackIds: ["jellyfin:aaa", "jellyfin:bbb"] })
        );

        await syncPlaylistToJellyfin("pl-1");

        expect(createJellyfinPlaylist).toHaveBeenCalledWith(CONFIG, "Road trip", [
            "aaa",
            "bbb",
        ]);
        expect(update).toHaveBeenCalledWith({
            where: { id: "pl-1" },
            data: { jellyfinPlaylistId: "jf-playlist-1" },
        });
    });

    it("adds only the tracks Jellyfin is missing", async () => {
        findUnique.mockResolvedValue(
            playlist({
                jellyfinPlaylistId: "jf-1",
                trackIds: ["jellyfin:aaa", "jellyfin:bbb"],
            })
        );
        getJellyfinPlaylistItems.mockResolvedValue([
            { entryId: "e1", itemId: "aaa" },
        ]);

        await syncPlaylistToJellyfin("pl-1");

        expect(addToJellyfinPlaylist).toHaveBeenCalledWith(CONFIG, "jf-1", [
            "bbb",
        ]);
        expect(createJellyfinPlaylist).not.toHaveBeenCalled();
    });

    it("does nothing when Jellyfin already has everything", async () => {
        findUnique.mockResolvedValue(
            playlist({ jellyfinPlaylistId: "jf-1", trackIds: ["jellyfin:aaa"] })
        );
        getJellyfinPlaylistItems.mockResolvedValue([
            { entryId: "e1", itemId: "aaa" },
        ]);

        await syncPlaylistToJellyfin("pl-1");

        expect(addToJellyfinPlaylist).not.toHaveBeenCalled();
    });

    it("creates the playlist late, once a song finally resolves", async () => {
        // An import that matched nothing has no Jellyfin copy. When a download
        // lands days later, that is the moment to make one.
        findUnique.mockResolvedValue(
            playlist({ jellyfinPlaylistId: null, trackIds: ["jellyfin:ccc"] })
        );

        await syncPlaylistToJellyfin("pl-1");

        expect(createJellyfinPlaylist).toHaveBeenCalledWith(
            CONFIG,
            "Road trip",
            ["ccc"]
        );
    });

    it("ignores tracks that are not Jellyfin items", async () => {
        findUnique.mockResolvedValue(
            playlist({ trackIds: ["ckxyz123", "jellyfin:aaa"] })
        );

        await syncPlaylistToJellyfin("pl-1");

        expect(createJellyfinPlaylist).toHaveBeenCalledWith(
            CONFIG,
            "Road trip",
            ["aaa"]
        );
    });

    it("leaves a native library alone", async () => {
        findUnique.mockResolvedValue(
            playlist({ trackIds: ["ckxyz123", "ckabc456"] })
        );

        await syncPlaylistToJellyfin("pl-1");

        expect(createJellyfinPlaylist).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("does nothing when Jellyfin is not configured", async () => {
        getJellyfinConfig.mockResolvedValue(null);

        await syncPlaylistToJellyfin("pl-1");

        expect(findUnique).not.toHaveBeenCalled();
        expect(createJellyfinPlaylist).not.toHaveBeenCalled();
    });

    it("does not record an id when Jellyfin refuses the playlist", async () => {
        findUnique.mockResolvedValue(playlist({ trackIds: ["jellyfin:aaa"] }));
        createJellyfinPlaylist.mockResolvedValue(null);

        await syncPlaylistToJellyfin("pl-1");

        expect(update).not.toHaveBeenCalled();
    });

    it("stays quiet when Jellyfin errors, so the playlist still stands", async () => {
        findUnique.mockResolvedValue(playlist({ trackIds: ["jellyfin:aaa"] }));
        createJellyfinPlaylist.mockRejectedValue(new Error("unreachable"));

        await expect(syncPlaylistToJellyfin("pl-1")).resolves.toBeUndefined();
    });
});
