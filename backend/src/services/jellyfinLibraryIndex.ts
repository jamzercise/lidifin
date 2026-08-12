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
    artistKeyWithoutArticle,
    artistLookupKey,
    normalizeAlbumForMatching,
    normalizeForCompare,
    stringSimilarity,
    trackTitleBareKey,
    trackTitleKey,
} from "../utils/matchKeys";

/** One Jellyfin track, as needed for matching. */
export interface JellyfinLibraryEntry {
    /** `jellyfin:UUID`, usable directly as a PlaylistItem.trackId. */
    jellyfinId: string;
    /** Album artist, which on a compilation is the compiler. */
    artistName: string;
    /**
     * Performing artists. Empty for rows written before this was recorded, in
     * which case only the album artist is available.
     */
    trackArtists?: string[];
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
 *
 * Each artist is indexed under both its full key and its key without a leading
 * article, so the two spellings of the same act reach the same tracks.
 */
export interface JellyfinTrackIndex {
    /** artist key -> that artist's tracks. */
    byArtist: Map<string, JellyfinLibraryEntry[]>;
    /** `artistKey|titleKey` -> tracks, for the common exact hit. */
    byArtistTitle: Map<string, JellyfinLibraryEntry[]>;
    /** `artistKey|bareTitleKey` -> tracks, ignoring any parenthetical. */
    byArtistBareTitle: Map<string, JellyfinLibraryEntry[]>;
    /** Total entries indexed; 0 means the metadata sync has not run. */
    size: number;
}

/**
 * Why a lookup failed, for diagnosing a track the user believes they own.
 */
export interface JellyfinLookupMiss {
    /** Whether the artist is in the library at all. */
    artistFound: boolean;
    /** How many tracks that artist has. */
    artistTrackCount: number;
    /** Closest title under that artist, and its score. */
    closestTitle: string | null;
    closestScore: number;
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
    const byArtistBareTitle = new Map<string, JellyfinLibraryEntry[]>();

    for (const entry of entries) {
        // Every artist this track can reasonably be searched by: the album
        // artist, each performing artist, and each of those without a leading
        // article. A compilation track is only findable via its performers.
        const artistKeys = new Set<string>();
        for (const name of [entry.artistName, ...(entry.trackArtists ?? [])]) {
            if (!name) continue;
            artistKeys.add(artistLookupKey(name));
            artistKeys.add(artistKeyWithoutArticle(name));
        }
        artistKeys.delete("");
        if (artistKeys.size === 0) continue;

        const titleKey = trackTitleKey(entry.trackTitle);
        const bareKey = trackTitleBareKey(entry.trackTitle);

        for (const key of artistKeys) {
            pushTo(byArtist, key, entry);
            if (titleKey) pushTo(byArtistTitle, `${key}|${titleKey}`, entry);
            if (bareKey && bareKey !== titleKey) {
                pushTo(byArtistBareTitle, `${key}|${bareKey}`, entry);
            }
        }
    }

    return { byArtist, byArtistTitle, byArtistBareTitle, size: entries.length };
}

function albumScore(
    candidate: JellyfinLibraryEntry,
    wantedAlbum: string | null
): number {
    if (!wantedAlbum || !candidate.albumTitle) return 0;

    const wanted = normalizeAlbumForMatching(wantedAlbum).toLowerCase();
    const have = normalizeAlbumForMatching(candidate.albumTitle).toLowerCase();
    if (!wanted || !have) return 0;

    if (have === wanted) return 100;
    if (have.includes(wanted) || wanted.includes(have)) return 80;
    return stringSimilarity(have, wanted);
}

/**
 * Choose between candidates that all matched on the same key.
 *
 * The requested album decides first, so a track present on both a studio album
 * and a compilation resolves to the right release. Failing that the closest
 * title wins, which keeps a plain "Redlight" from resolving to
 * "Redlight (Live)" when an unadorned copy exists.
 */
function pickBestCandidate(
    candidates: JellyfinLibraryEntry[],
    source: { title: string; album: string | null }
): JellyfinLibraryEntry {
    if (candidates.length === 1) return candidates[0];

    const wantedTitle = trackTitleKey(source.title);
    const wantedRaw = normalizeForCompare(source.title);

    let best = candidates[0];
    let bestAlbum = -1;
    let bestTitle = -1;
    let bestRaw = -1;

    for (const candidate of candidates) {
        const album = albumScore(candidate, source.album);
        const title =
            trackTitleKey(candidate.trackTitle) === wantedTitle
                ? 100
                : stringSimilarity(
                      wantedTitle,
                      trackTitleKey(candidate.trackTitle)
                  );
        // Candidates matched on a normalized key, so "Redlight (Live)" and
        // "Redlight" look identical by now. Comparing the untouched titles is
        // what prefers the plain studio recording the user actually asked for.
        const raw = stringSimilarity(
            wantedRaw,
            normalizeForCompare(candidate.trackTitle)
        );

        if (
            album > bestAlbum ||
            (album === bestAlbum &&
                (title > bestTitle || (title === bestTitle && raw > bestRaw)))
        ) {
            bestAlbum = album;
            bestTitle = title;
            bestRaw = raw;
            best = candidate;
        }
    }

    return best;
}

/**
 * Find a Jellyfin track for a source track, in decreasing order of certainty:
 *
 * 1. Same artist and title, once remaster/edition/featured noise is removed and
 *    ampersands and "Pt."/"Part" are canonicalized.
 * 2. Same artist, same title ignoring a parenthetical on either side, which is
 *    weaker because a parenthetical occasionally marks a different recording.
 * 3. Same artist, closest remaining title above the similarity threshold.
 *
 * Either artist spelling (with or without a leading article) reaches step 1,
 * since both are indexed.
 */
export function lookupJellyfinTrack(
    index: JellyfinTrackIndex,
    source: { artist: string; title: string; album?: string | null }
): JellyfinTrackMatch | null {
    // Either spelling of the artist, since the library may be filed under
    // either and only one of them is the source's.
    const artistKeys = [
        ...new Set([
            artistLookupKey(source.artist),
            artistKeyWithoutArticle(source.artist),
        ]),
    ].filter(Boolean);
    if (!artistKeys.length) return null;

    const album =
        source.album && source.album !== "Unknown Album" ? source.album : null;

    const resolve = (
        candidates: JellyfinLibraryEntry[],
        ceiling: number
    ): JellyfinTrackMatch => {
        const entry = pickBestCandidate(candidates, {
            title: source.title,
            album,
        });
        const albumAgrees = !album || albumScore(entry, album) >= 80;
        return {
            entry,
            matchType: "exact",
            confidence: Math.min(albumAgrees ? 100 : 90, ceiling),
        };
    };

    const titleKey = trackTitleKey(source.title);
    const bareKey = trackTitleBareKey(source.title);

    if (titleKey) {
        for (const artistKey of artistKeys) {
            const exact = index.byArtistTitle.get(`${artistKey}|${titleKey}`);
            if (exact?.length) return resolve(exact, 100);
        }
    }

    // A parenthetical on one side only: "Raid" against "Raid (Original Mix)".
    for (const artistKey of artistKeys) {
        for (const key of new Set([titleKey, bareKey])) {
            if (!key) continue;
            const loose =
                index.byArtistBareTitle.get(`${artistKey}|${key}`) ??
                (key !== titleKey
                    ? index.byArtistTitle.get(`${artistKey}|${key}`)
                    : undefined);
            if (loose?.length) return resolve(loose, 95);
        }
    }

    const byArtist = artistKeys.flatMap(
        (artistKey) => index.byArtist.get(artistKey) ?? []
    );
    if (!byArtist.length || !titleKey) return null;

    let best: JellyfinLibraryEntry | null = null;
    let bestScore = 0;

    for (const candidate of byArtist) {
        const score = stringSimilarity(
            titleKey,
            trackTitleKey(candidate.trackTitle)
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
 * Explain why a lookup found nothing, so a track the user is sure they own can
 * be diagnosed from the logs instead of by guesswork.
 */
export function explainJellyfinMiss(
    index: JellyfinTrackIndex,
    source: { artist: string; title: string }
): JellyfinLookupMiss {
    const candidates =
        index.byArtist.get(artistLookupKey(source.artist)) ??
        index.byArtist.get(artistKeyWithoutArticle(source.artist)) ??
        [];

    const titleKey = trackTitleKey(source.title);
    let closestTitle: string | null = null;
    let closestScore = 0;

    for (const candidate of candidates) {
        const score = stringSimilarity(
            titleKey,
            trackTitleKey(candidate.trackTitle)
        );
        if (score > closestScore) {
            closestScore = score;
            closestTitle = candidate.trackTitle;
        }
    }

    return {
        artistFound: candidates.length > 0,
        artistTrackCount: candidates.length,
        closestTitle,
        closestScore,
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
                trackArtists: true,
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
