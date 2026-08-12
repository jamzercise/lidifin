import {
    areArtistNamesSimilar,
    canonicalizeVariousArtists,
    extractPrimaryArtist,
    normalizeArtistName,
    parseArtistFromPath,
} from "../artistNormalization";

describe("extractPrimaryArtist", () => {
    describe("collaborations", () => {
        it.each([
            ["Ric Wilson x Chromeo x A-Trak", "Ric Wilson"],
            ["Artist A x Artist B", "Artist A"],
            ["CHVRCHES & Robert Smith", "CHVRCHES"],
        ])("takes the lead artist of %s", (input, expected) => {
            expect(extractPrimaryArtist(input)).toBe(expected);
        });

        it.each([
            ["Philip Glass, Atlanta Symphony Orchestra", "Philip Glass"],
            ["Yo-Yo Ma, New York Philharmonic", "Yo-Yo Ma"],
        ])("drops the accompanying ensemble in %s", (input, expected) => {
            expect(extractPrimaryArtist(input)).toBe(expected);
        });
    });

    describe("featured artists", () => {
        it.each([
            "Artist feat. Someone",
            "Artist feat Someone",
            "Artist ft. Someone",
            "Artist ft Someone",
            "Artist featuring Guest",
        ])("strips the guest from %s", (input) => {
            expect(extractPrimaryArtist(input)).toBe("Artist");
        });
    });

    describe("band names that read like collaborations", () => {
        // The hard cases: an ampersand or "and" inside a single band's name
        // must not be mistaken for two artists.
        it.each([
            "Of Mice & Men",
            "Between the Buried and Me",
            "Coheed and Cambria",
            "The Naked and Famous",
            "Earth, Wind & Fire",
        ])("keeps %s whole", (input) => {
            expect(extractPrimaryArtist(input)).toBe(input);
        });
    });

    describe("names with nothing to strip", () => {
        it.each(["Radiohead", "The Beatles"])("returns %s unchanged", (input) => {
            expect(extractPrimaryArtist(input)).toBe(input);
        });
    });

    describe("missing names", () => {
        // Callers write this straight to a required column, so it can never
        // come back empty.
        it.each(["", "   "])("falls back to a placeholder for %p", (input) => {
            expect(extractPrimaryArtist(input)).toBe("Unknown Artist");
        });
    });
});

describe("parseArtistFromPath", () => {
    it.each([
        ["Paramore - After Laughter (2017) FLAC", "Paramore"],
        ["Radiohead - OK Computer", "Radiohead"],
        ["The Beatles - Abbey Road (1969)", "The Beatles"],
        ["Paramore-After.Laughter-FLAC-2017", "Paramore"],
    ])("reads the artist out of %s", (input, expected) => {
        expect(parseArtistFromPath(input)).toBe(expected);
    });
});

describe("canonicalizeVariousArtists", () => {
    it.each(["VA", "V.A.", "V/A", "Various", "Various Artist", "<Various Artists>"])(
        "recognises %s as a compilation",
        (input) => {
            expect(canonicalizeVariousArtists(input)).toBe("Various Artists");
        }
    );

    it("leaves a real artist alone", () => {
        expect(canonicalizeVariousArtists("Daft Punk")).toBe("Daft Punk");
    });
});

describe("normalizeArtistName", () => {
    // This produces the key stored in Artist.normalizedName and used for
    // lookups, so these are the exact conventions matching depends on.
    it.each([
        ["RADIOHEAD", "radiohead"],
        ["Ólafur Arnalds", "olafur arnalds"],
        ["Of Mice & Men", "of mice and men"],
        ["The    Beatles", "the beatles"],
    ])("normalizes %s to %s", (input, expected) => {
        expect(normalizeArtistName(input)).toBe(expected);
    });
});

describe("areArtistNamesSimilar", () => {
    it.each([
        ["Ólafur Arnalds", "Olafur Arnalds"],
        ["Of Mice & Men", "Of Mice And Men"],
        ["The Weeknd", "The Weekend"],
    ])("treats %s and %s as the same artist", (a, b) => {
        expect(areArtistNamesSimilar(a, b)).toBe(true);
    });

    it("keeps unrelated artists apart", () => {
        expect(areArtistNamesSimilar("Radiohead", "Coldplay")).toBe(false);
    });
});
