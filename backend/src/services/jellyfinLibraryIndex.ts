/**
 * Matching imported playlist tracks against a Jellyfin library.
 *
 * When Jellyfin is the music source the Prisma Artist/Album/Track tables are
 * not a mirror of the library — the filesystem scan is skipped entirely and
 * browsing reads Jellyfin at request time. The library index that does exist
 * locally is JellyfinTrackMetadata, kept current by the periodic Jellyfin
 * metadata sync. Playlist imports therefore have to match against that table,
 * or they report every track as missing and re-download a library the user
 * already has.
 *
 * The index is built once per import and reused for every track in the
 * playlist: one pass over the table instead of several queries per track, and
 * no dependence on database collation for case- or accent-insensitivity.
 */

import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    artistLookupKey,
    normalizeAlbumForMatching,
    normalizeForCompare,
    normalizeTrackTitle,
    stringSimilarity,
} from "../utils/matchKeys";

/** One Jellyfin track, as needed for matching. */
export interface JellyfinLibraryEntry {
    /** `jellyfin:UUID`, usable directly as a PlaylistItem.trackId. */
    jellyfinId: string;
    artistName: string;
    trackTitle: string;
    albumTitle: string | null;
    rgMbid: string | null;
}

export interface JellyfinTrackMatch {
    entry: JellyfinLibraryEntry;
    matchType: "exact" | "fuzzy";
    confidence: number;
}

/**
 * Lookup structure over a Jellyfin library. Entries are grouped by artist key
 * so a candidate set can be narrowed before any title comparison.
 */
export interface JellyfinTrackIndex {
    /** artist key -> that artist's tracks. */
    byArtist: Map<string, JellyfinLibraryEntry[]>;
    /** `artistKey|titleKey` -> tracks, for the common exact hit. */
    byArtistTitle: Map<string, JellyfinLibraryEntry[]>;
    /** Total entries indexed; 0 means the metadata sync has not run. */
    size: number;
}

/** Minimum title similarity before a fuzzy match is believed. */
const FUZZY_TITLE_THRESHOLD = 82;

/**
 * How many rows to pull per page when loading the index. The table holds one
 * short row per track, so a large library is still a modest read.
 */
const INDEX_PAGE_SIZE = 5000;

/**
 * Refuse to build an unbounded index. Well past any realistic personal
 * library, and a bound is cheaper than an out-of-memory backend.
 */
const INDEX_MAX_ENTRIES = 500_000;

function pushTo(
    map: Map<string, JellyfinLibraryEntry[]>,
    key: string,
    entry: JellyfinLibraryEntry
): void {
    const existing = map.get(key);
    if (existing) {
        existing.push(entry);
    } else {
        map.set(key, [entry]);
    }
}

/**
 * Build the lookup structure from raw entries. Pure, so the matching rules can
 * be tested without a database.
 */
export function buildJellyfinTrackIndex(
    entries: JellyfinLibraryEntry[]
): JellyfinTrackIndex {
    const byArtist = new Map<string, JellyfinLibraryEntry[]>();
    const byArtistTitle = new Map<string, JellyfinLibraryEntry[]>();

    for (const entry of entries) {
        const artistKey = artistLookupKey(entry.artistName);
        if (!artistKey) continue;

        pushTo(byArtist, artistKey, entry);
        pushTo(
            byArtistTitle,
            `${artistKey}|${normalizeTrackTitle(entry.trackTitle)}`,
            entry
        );
    }

    return { byArtist, byArtistTitle, size: entries.length };
}

/**
 * Pick the entry whose album best fits the one we were asked for, so a track
 * present on both an album and a compilation resolves to the right release.
 */
function preferAlbum(
    candidates: JellyfinLibraryEntry[],
    album: string | null
): JellyfinLibraryEntry {
    if (candidates.length === 1 || !album) return candidates[0];

    const wanted = normalizeAlbumForMatching(album).toLowerCase();
    if (!wanted) return candidates[0];

    let best = candidates[0];
    let bestScore = -1;

    for (const candidate of candidates) {
        if (!candidate.albumTitle) continue;
        const have = normalizeAlbumForMatching(
            candidate.albumTitle
        ).toLowerCase();
        const score =
            have === wanted
                ? 100
                : have.includes(wanted) || wanted.includes(have)
                ? 80
                : stringSimilarity(have, wanted);
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }

    return best;
}

/**
 * Find a Jellyfin track for a source track, in decreasing order of certainty:
 * an exact artist and title hit, then the best fuzzy title within that artist.
 */
export function lookupJellyfinTrack(
    index: JellyfinTrackIndex,
    source: { artist: string; title: string; album?: string | null }
): JellyfinTrackMatch | null {
    const artistKey = artistLookupKey(source.artist);
    if (!artistKey) return null;

    const album = source.album && source.album !== "Unknown Album"
        ? source.album
        : null;

    // Exact: same artist, same title once remaster/edition noise is removed.
    const exact = index.byArtistTitle.get(
        `${artistKey}|${normalizeTrackTitle(source.title)}`
    );
    if (exact?.length) {
        const entry = preferAlbum(exact, album);
        const albumAgrees =
            !album ||
            !entry.albumTitle ||
            normalizeAlbumForMatching(entry.albumTitle).toLowerCase() ===
                normalizeAlbumForMatching(album).toLowerCase();
        return {
            entry,
            matchType: "exact",
            confidence: albumAgrees ? 100 : 90,
        };
    }

    // Fuzzy: same artist, closest title. Catches punctuation differences,
    // "Pt. 2" vs "Part 2", and featured-artist noise inside the title.
    const byArtist = index.byArtist.get(artistKey);
    if (!byArtist?.length) return null;

    const wantedTitle = normalizeTrackTitle(source.title);
    if (!wantedTitle) return null;

    let best: JellyfinLibraryEntry | null = null;
    let bestScore = 0;

    for (const candidate of byArtist) {
        const score = stringSimilarity(
            wantedTitle,
            normalizeTrackTitle(candidate.trackTitle)
        );
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }

    if (!best || bestScore < FUZZY_TITLE_THRESHOLD) return null;

    return {
        entry: best,
        matchType: "fuzzy",
        // Cap below an exact hit so callers can tell the two apart.
        confidence: Math.min(bestScore, 89),
    };
}

/**
 * Load every Jellyfin track into an index. Paged so a large library doesn't
 * arrive as one enormous result set.
 */
export async function loadJellyfinTrackIndex(): Promise<JellyfinTrackIndex> {
    const entries: JellyfinLibraryEntry[] = [];

    for (let skip = 0; skip < INDEX_MAX_ENTRIES; skip += INDEX_PAGE_SIZE) {
        const page = await prisma.jellyfinTrackMetadata.findMany({
            select: {
                jellyfinId: true,
                artistName: true,
                trackTitle: true,
                albumTitle: true,
                rgMbid: true,
            },
            orderBy: { jellyfinId: "asc" },
            skip,
            take: INDEX_PAGE_SIZE,
        });

        entries.push(...page);
        if (page.length < INDEX_PAGE_SIZE) break;
    }

    if (entries.length === 0) {
        logger.warn(
            "[Import] Jellyfin is the music source but no Jellyfin track metadata is stored, " +
                "so nothing can be matched against the library and every track will look missing. " +
                "Run the Jellyfin metadata sync from Settings, or wait for the periodic sync."
        );
    } else {
        logger.debug(
            `[Import] Indexed ${entries.length} Jellyfin tracks for library matching`
        );
    }

    return buildJellyfinTrackIndex(entries);
}
