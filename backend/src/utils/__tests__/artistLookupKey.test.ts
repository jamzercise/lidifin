/**
 * artist.normalizedName is written by the scanner via normalizeArtistName, and
 * every lookup that filters on that column has to produce the identical value.
 *
 * The import matcher used to build its key with a normalizer that stripped all
 * punctuation, so "Guns N' Roses" was stored as "guns n' roses" but looked up
 * as "guns n roses" — the track was in the library and the import reported it
 * as missing anyway. These tests pin the shape of the stored value so that
 * trap stays closed.
 */

import { normalizeArtistName } from "../artistNormalization";

describe("artist.normalizedName contract", () => {
    it("keeps punctuation, because the stored value keeps it too", () => {
        expect(normalizeArtistName("Guns N' Roses")).toBe("guns n' roses");
        expect(normalizeArtistName("Panic! At The Disco")).toBe(
            "panic! at the disco"
        );
        expect(normalizeArtistName("AC/DC")).toBe("ac/dc");
        expect(normalizeArtistName("Blink-182")).toBe("blink-182");
        expect(normalizeArtistName("will.i.am")).toBe("will.i.am");
        expect(normalizeArtistName("Tyler, The Creator")).toBe(
            "tyler, the creator"
        );
    });

    it("expands an ampersand to 'and' rather than dropping it", () => {
        expect(normalizeArtistName("Of Mice & Men")).toBe("of mice and men");
        expect(normalizeArtistName("Simon & Garfunkel")).toBe(
            "simon and garfunkel"
        );
        expect(normalizeArtistName("Earth, Wind & Fire")).toBe(
            "earth, wind and fire"
        );
    });

    it("strips diacritics so accented and plain spellings collapse together", () => {
        expect(normalizeArtistName("Sigur Rós")).toBe(
            normalizeArtistName("Sigur Ros")
        );
        expect(normalizeArtistName("Beyoncé")).toBe("beyonce");
    });

    it("moves a trailing article to the front", () => {
        expect(normalizeArtistName("Books, The")).toBe(
            normalizeArtistName("The Books")
        );
    });

    it("is stable, so re-normalizing a stored value returns it unchanged", () => {
        // Lookups sometimes normalize a value that already came out of the
        // column; that has to be a no-op or the second pass misses.
        for (const name of [
            "Guns N' Roses",
            "Of Mice & Men",
            "AC/DC",
            "Sigur Rós",
            "The Books",
            "Radiohead",
        ]) {
            const stored = normalizeArtistName(name);
            expect(normalizeArtistName(stored)).toBe(stored);
        }
    });

    it("does not collapse to a punctuation-stripped form", () => {
        // Guards against a future 'simplification' that would silently break
        // every lookup built from the stored value.
        const strippedOfPunctuation = (value: string) =>
            value.replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();

        for (const name of ["Guns N' Roses", "AC/DC", "Panic! At The Disco"]) {
            const stored = normalizeArtistName(name);
            expect(stored).not.toBe(strippedOfPunctuation(stored));
        }
    });
});
