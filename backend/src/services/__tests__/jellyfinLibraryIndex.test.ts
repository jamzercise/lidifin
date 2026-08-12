import {
    buildJellyfinTrackIndex,
    explainJellyfinMiss,
    lookupJellyfinTrack,
    type JellyfinLibraryEntry,
} from "../jellyfinLibraryIndex";

function entry(
    artistName: string,
    trackTitle: string,
    albumTitle: string | null = "An Album",
    jellyfinId = `jellyfin:${artistName}-${trackTitle}`
): JellyfinLibraryEntry {
    return { jellyfinId, artistName, trackTitle, albumTitle, rgMbid: null };
}

describe("lookupJellyfinTrack", () => {
    it("matches an exact artist, title and album", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Lucky", "OK Computer"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Radiohead",
            title: "Lucky",
            album: "OK Computer",
        });

        expect(match?.entry.albumTitle).toBe("OK Computer");
        expect(match?.matchType).toBe("exact");
        expect(match?.confidence).toBe(100);
    });

    it("returns nothing when the artist is absent", () => {
        const index = buildJellyfinTrackIndex([entry("Radiohead", "Lucky")]);

        expect(
            lookupJellyfinTrack(index, {
                artist: "Portishead",
                title: "Lucky",
                album: "Dummy",
            })
        ).toBeNull();
    });

    // The whole point of the fix: these are the names that could never match.
    it.each([
        ["Guns N' Roses", "Sweet Child O' Mine"],
        ["Of Mice & Men", "Second & Sebring"],
        ["AC/DC", "Back In Black"],
        ["Panic! At The Disco", "Nine In The Afternoon"],
        ["Blink-182", "Dammit"],
        ["will.i.am", "Scream & Shout"],
        ["Sigur Rós", "Hoppípolla"],
    ])("matches %s despite punctuation", (artist, title) => {
        const index = buildJellyfinTrackIndex([entry(artist, title)]);

        const match = lookupJellyfinTrack(index, { artist, title });

        expect(match).not.toBeNull();
        expect(match!.entry.artistName).toBe(artist);
    });

    it("matches when the two sides spell the ampersand differently", () => {
        const index = buildJellyfinTrackIndex([
            entry("Simon & Garfunkel", "America"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Simon and Garfunkel",
            title: "America",
        });

        expect(match?.entry.artistName).toBe("Simon & Garfunkel");
    });

    it("matches an accented artist against an unaccented source", () => {
        const index = buildJellyfinTrackIndex([entry("Sigur Rós", "Svefn-g-englar")]);

        const match = lookupJellyfinTrack(index, {
            artist: "Sigur Ros",
            title: "Svefn-g-englar",
        });

        expect(match?.entry.artistName).toBe("Sigur Rós");
    });

    it("ignores a remaster suffix on either side", () => {
        const index = buildJellyfinTrackIndex([
            entry("The Beatles", "Come Together - 2019 Remaster", "Abbey Road"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "The Beatles",
            title: "Come Together",
            album: "Abbey Road",
        });

        expect(match?.matchType).toBe("exact");
    });

    it("matches through a deluxe-edition album difference", () => {
        const index = buildJellyfinTrackIndex([
            entry("Ólafur Arnalds", "Near Light", "Living Room Songs"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Ólafur Arnalds",
            title: "Near Light",
            album: "Living Room Songs (Deluxe Edition)",
        });

        expect(match?.matchType).toBe("exact");
        expect(match?.confidence).toBe(100);
    });

    it("strips a featured artist before matching the primary one", () => {
        const index = buildJellyfinTrackIndex([entry("Radiohead", "Lucky")]);

        // extractPrimaryArtist is the caller's job, so the full credit should
        // not match on its own — this documents that boundary.
        expect(
            lookupJellyfinTrack(index, {
                artist: "Radiohead feat. Someone",
                title: "Lucky",
            })
        ).toBeNull();
    });

    it("prefers the requested album when a title appears on several", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Creep", "Pablo Honey", "jellyfin:studio"),
            entry("Radiohead", "Creep", "Itch", "jellyfin:compilation"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Radiohead",
            title: "Creep",
            album: "Itch",
        });

        expect(match?.entry.jellyfinId).toBe("jellyfin:compilation");
    });

    it("still matches when the album disagrees, but with less confidence", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Creep", "Pablo Honey"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Radiohead",
            title: "Creep",
            album: "Some Compilation Nobody Has",
        });

        expect(match?.matchType).toBe("exact");
        expect(match?.confidence).toBe(90);
    });

    it("treats Unknown Album as no album hint at all", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Creep", "Pablo Honey"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Radiohead",
            title: "Creep",
            album: "Unknown Album",
        });

        expect(match?.confidence).toBe(100);
    });

    it("falls back to a close title within the same artist", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Paranoid Android", "OK Computer"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Radiohead",
            title: "Paranoid Androids",
            album: "OK Computer",
        });

        expect(match?.matchType).toBe("fuzzy");
        expect(match!.confidence).toBeLessThan(100);
    });

    it("refuses a fuzzy match that is merely a different song", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Paranoid Android", "OK Computer"),
        ]);

        expect(
            lookupJellyfinTrack(index, {
                artist: "Radiohead",
                title: "Karma Police",
                album: "OK Computer",
            })
        ).toBeNull();
    });

    it("treats a title differing only in punctuation as the same title", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Everything In Its Right Place", "Kid A"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Radiohead",
            title: "Everything In Its Right Place!!!",
            album: "Kid A",
        });

        expect(match?.matchType).toBe("exact");
    });

    it("keeps a fuzzy match below the confidence of an exact one", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Paranoid Android", "OK Computer"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Radiohead",
            title: "Paranoid Androids",
            album: "OK Computer",
        });

        expect(match!.confidence).toBeLessThanOrEqual(89);
    });

    // Title spellings that differ between catalogues. Each of these was a
    // reported miss: the playlist said one thing, the library said the other.
    describe("title spelling differences", () => {
        it.each([
            ["Rude and Reckless", "Rude & Reckless"],
            ["Rude & Reckless", "Rude and Reckless"],
            ["Ghost Town", "Ghost Town (feat. Rico Rodriguez)"],
            ["Ghost Town (feat. Rico Rodriguez)", "Ghost Town"],
            ["Ghost Town", "Ghost Town feat. Rico Rodriguez"],
            ["Raid", "Raid (Original Mix)"],
            ["Raid (Original Mix)", "Raid"],
            ["Pt. 2", "Part 2"],
            ["Part 2", "Pt. 2"],
            ["Nite Klub", "Nite Klub - Remastered"],
            ["A Message To You Rudy", "A Message to You, Rudy"],
            ["Too Much Too Young [Live]", "Too Much Too Young"],
            ["Simmer Down", "Simmer Down (with The Wailers)"],
        ])("finds %s when the library says %s", (sourceTitle, libraryTitle) => {
            const index = buildJellyfinTrackIndex([
                entry("The Specials", libraryTitle),
            ]);

            const match = lookupJellyfinTrack(index, {
                artist: "The Specials",
                title: sourceTitle,
            });

            expect(match).not.toBeNull();
            expect(match!.entry.trackTitle).toBe(libraryTitle);
        });

        it("ranks a parenthetical-only difference below an exact title", () => {
            const index = buildJellyfinTrackIndex([
                entry("The Slackers", "Redlight (Original Mix)"),
            ]);

            const match = lookupJellyfinTrack(index, {
                artist: "The Slackers",
                title: "Redlight",
            });

            expect(match!.confidence).toBeLessThan(100);
        });

        it("prefers the exact title over one with a parenthetical", () => {
            const index = buildJellyfinTrackIndex([
                entry("The Slackers", "Redlight (Live)", "Live", "jellyfin:live"),
                entry("The Slackers", "Redlight", "Redlight", "jellyfin:studio"),
            ]);

            const match = lookupJellyfinTrack(index, {
                artist: "The Slackers",
                title: "Redlight",
            });

            expect(match?.entry.jellyfinId).toBe("jellyfin:studio");
        });

        it("still refuses two genuinely different songs", () => {
            const index = buildJellyfinTrackIndex([
                entry("The Specials", "Ghost Town"),
            ]);

            expect(
                lookupJellyfinTrack(index, {
                    artist: "The Specials",
                    title: "Gangsters",
                })
            ).toBeNull();
        });
    });

    describe("artist article differences", () => {
        it.each([
            ["The Slackers", "Slackers"],
            ["Slackers", "The Slackers"],
            ["the Slackers", "The Slackers"],
        ])("finds %s when the library says %s", (sourceArtist, libraryArtist) => {
            const index = buildJellyfinTrackIndex([
                entry(libraryArtist, "Redlight"),
            ]);

            const match = lookupJellyfinTrack(index, {
                artist: sourceArtist,
                title: "Redlight",
            });

            expect(match?.entry.artistName).toBe(libraryArtist);
        });

        it("does not conflate two different artists sharing a word", () => {
            const index = buildJellyfinTrackIndex([entry("The Specials", "X")]);

            expect(
                lookupJellyfinTrack(index, { artist: "The Special AKA", title: "X" })
            ).toBeNull();
        });
    });

    it("handles an empty library without throwing", () => {
        const index = buildJellyfinTrackIndex([]);

        expect(index.size).toBe(0);
        expect(
            lookupJellyfinTrack(index, { artist: "Radiohead", title: "Creep" })
        ).toBeNull();
    });

    it("skips entries with an unusable artist name", () => {
        const index = buildJellyfinTrackIndex([entry("", "Orphan Track")]);

        expect(index.byArtist.size).toBe(0);
        expect(
            lookupJellyfinTrack(index, { artist: "", title: "Orphan Track" })
        ).toBeNull();
    });

    it("returns ids that can be used directly as playlist track ids", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Lucky", "OK Computer", "jellyfin:abc-123"),
        ]);

        const match = lookupJellyfinTrack(index, {
            artist: "Radiohead",
            title: "Lucky",
        });

        expect(match?.entry.jellyfinId).toMatch(/^jellyfin:/);
    });
});

describe("explainJellyfinMiss", () => {
    it("reports an artist that is not in the library", () => {
        const index = buildJellyfinTrackIndex([entry("The Specials", "Ghost Town")]);

        const miss = explainJellyfinMiss(index, {
            artist: "Aggro Reggae",
            title: "Whatever",
        });

        expect(miss.artistFound).toBe(false);
        expect(miss.artistTrackCount).toBe(0);
        expect(miss.closestTitle).toBeNull();
    });

    it("reports the closest title when the artist is present", () => {
        const index = buildJellyfinTrackIndex([
            entry("The Specials", "Ghost Town"),
            entry("The Specials", "Gangsters"),
        ]);

        const miss = explainJellyfinMiss(index, {
            artist: "The Specials",
            title: "Ghost Towns of the Future",
        });

        expect(miss.artistFound).toBe(true);
        expect(miss.closestTitle).toBe("Ghost Town");
        expect(miss.closestScore).toBeGreaterThan(0);
    });

    it("finds the artist even when only the article differs", () => {
        const index = buildJellyfinTrackIndex([entry("Slackers", "Redlight")]);

        expect(
            explainJellyfinMiss(index, { artist: "The Slackers", title: "Nope" })
                .artistFound
        ).toBe(true);
    });
});

describe("buildJellyfinTrackIndex", () => {
    it("groups every track by its artist", () => {
        const index = buildJellyfinTrackIndex([
            entry("Radiohead", "Creep"),
            entry("Radiohead", "Lucky"),
            entry("Portishead", "Roads"),
        ]);

        expect(index.byArtist.get("radiohead")).toHaveLength(2);
        expect(index.byArtist.get("portishead")).toHaveLength(1);
        expect(index.size).toBe(3);
    });

    it("collapses artist spellings that differ only in punctuation or accents", () => {
        const index = buildJellyfinTrackIndex([
            entry("Sigur Rós", "A"),
            entry("Sigur Ros", "B"),
        ]);

        expect(index.byArtist.size).toBe(1);
        expect(index.byArtist.get("sigur ros")).toHaveLength(2);
    });
});
