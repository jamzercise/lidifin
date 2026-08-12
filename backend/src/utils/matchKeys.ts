/**
 * Shared normalizers for matching imported playlist tracks against the library.
 *
 * These live in one place on purpose. The import matcher previously kept its own
 * private copies, and when a second matcher needed the same logic the two
 * drifted: one stripped punctuation, the other didn't, and every artist with an
 * apostrophe or an ampersand became unfindable. Anything that compares a source
 * track to a library track should import from here rather than re-deriving it.
 */

import { normalizeArtistName } from "./artistNormalization";

/**
 * Normalize a string for fuzzy comparison: lowercase, accents folded,
 * punctuation dropped. Both sides of a comparison must go through this, since
 * it is lossy.
 */
export function normalizeForCompare(str: string): string {
    return (
        str
            .toLowerCase()
            // Normalize special characters (ö→o, é→e, etc.)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            // Remove punctuation but keep spaces
            .replace(/[^\w\s]/g, "")
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * Normalize apostrophes and quotes to ASCII versions.
 * Handles: ' ' ` ′ ʼ → '
 */
export function normalizeApostrophes(str: string): string {
    return str
        .replace(/[''`′ʼ]/g, "'") // Various apostrophe forms → ASCII apostrophe
        .replace(/[""]/g, '"'); // Smart quotes → ASCII quotes
}

/**
 * Strip remaster/version suffixes but KEEP punctuation.
 * "Ain't Gonna Rain Anymore - 2011 Remaster" → "Ain't Gonna Rain Anymore"
 * Used for database searches where we need to match punctuation.
 */
export function stripTrackSuffix(str: string): string {
    return (
        normalizeApostrophes(str)
            // Remove " - YEAR Remaster", " - Remastered YEAR", " - Radio Edit", etc.
            // Note: remaster(ed)? matches "remaster" or "remastered"
            .replace(
                /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|mono|stereo|version|edition|mix)(\s+\d{4})?(\s+(version|edition|mix))?.*$/i,
                ""
            )
            // Remove " - YEAR" at end
            .replace(/\s*-\s*\d{4}\s*$/, "")
            // Remove "(Live at...)", "(Live from...)", "(Recorded at...)" parenthetical content
            .replace(
                /\s*\([^)]*(?:live at|live from|recorded at|performed at)[^)]*\)\s*/gi,
                " "
            )
            // Remove parenthetical content like "(Remastered)" or "(2011 Remastered Version)"
            .replace(/\s*\([^)]*remaster[^)]*\)\s*/gi, " ")
            .replace(/\s*\([^)]*version[^)]*\)\s*/gi, " ")
            .replace(/\s*\([^)]*edition[^)]*\)\s*/gi, " ")
            // Remove general "(Live)" or "(Live 2021)" etc
            .replace(/\s*\(\s*live\s*(\d{4})?\s*\)\s*/gi, " ")
            // Remove bracketed content like "[Deluxe Edition]"
            .replace(/\s*\[[^\]]*\]\s*/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * Normalize track title - removes remaster/version suffixes AND punctuation.
 * "Ain't Gonna Rain Anymore - 2011 Remaster" → "aint gonna rain anymore"
 * Used for similarity comparisons.
 */
export function normalizeTrackTitle(str: string): string {
    return normalizeForCompare(stripTrackSuffix(str));
}

/**
 * Normalize album title for matching - strips common suffixes.
 * "In A Time Lapse (Deluxe Edition)" → "In A Time Lapse"
 */
export function normalizeAlbumForMatching(str: string): string {
    return stripTrackSuffix(str).trim();
}

/**
 * Calculate similarity between two strings (0-100).
 */
export function stringSimilarity(a: string, b: string): number {
    const s1 = normalizeForCompare(a);
    const s2 = normalizeForCompare(b);

    if (s1 === s2) return 100;

    // Check if one contains the other
    if (s1.includes(s2) || s2.includes(s1)) {
        const longer = Math.max(s1.length, s2.length);
        const shorter = Math.min(s1.length, s2.length);
        return Math.round((shorter / longer) * 100);
    }

    // Simple word overlap similarity
    const words1 = new Set(s1.split(" "));
    const words2 = new Set(s2.split(" "));
    const intersection = [...words1].filter((w) => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return Math.round((intersection / union) * 100);
}

/**
 * Build the comparison key for an artist name.
 *
 * Also the lookup value for the Prisma artist.normalizedName column, which the
 * scanner writes with this same function — normalizeForCompare must never be
 * used for that, since it drops the punctuation the column keeps.
 */
export function artistLookupKey(name: string): string {
    return normalizeArtistName(name);
}

/**
 * First word of the artist key, for broader `contains` searches.
 */
export function artistLookupFirstWord(name: string): string {
    return artistLookupKey(name).split(" ")[0] ?? "";
}
