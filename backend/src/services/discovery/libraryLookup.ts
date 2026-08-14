/**
 * Reading the user's library during Discover, whichever music source is in use.
 *
 * Discover has to consult the library constantly: to tell whether a
 * recommendation is already owned, to find the tracks of an album it just
 * downloaded, and to pick familiar anchor tracks. All of that was written
 * against the Prisma Artist/Album/Track tables, which are only populated when
 * Lidifin does its own filesystem scan. When Jellyfin is the music source the
 * scan is skipped and those tables stay empty, so every one of those questions
 * silently answered "nothing" — Discover would download an album, fail to find
 * a single track of it afterwards, and mark the batch failed.
 *
 * This module answers those questions against whichever source is authoritative.
 * The Prisma paths are the original queries, unchanged, so native libraries
 * behave exactly as before; the Jellyfin paths read JellyfinTrackMetadata
 * through the same matching index that playlist imports use.
 */

import { normalizeArtistName } from "../../utils/artistNormalization";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    artistKeyWithoutArticle,
    artistLookupKey,
    normalizeAlbumForMatching,
} from "../../utils/matchKeys";
import { isJellyfinMusicSource } from "../jellyfin";
import {
    JellyfinLibraryEntry,
    JellyfinTrackIndex,
    loadJellyfinTrackIndex,
    lookupJellyfinAlbum,
    lookupJellyfinTrack,
} from "../jellyfinLibraryIndex";

/**
 * A library track in the shape Discover's playlist builder consumes. Native
 * rows already satisfy this, so they are passed through untouched and keep
 * their extra Prisma fields; Jellyfin entries are mapped onto it.
 */
export interface LibraryTrackRef {
    /** Native cuid, or `jellyfin:<uuid>`. Stored on DiscoveryTrack.trackId. */
    id: string;
    title: string;
    /** Empty for Jellyfin, which exposes no filesystem path. */
    filePath: string;
    album: {
        /** Grouping key, used to keep a playlist to one track per album. */
        id: string;
        title: string;
        /** Never empty: DiscoveryAlbum keys on it. Synthesized if unknown. */
        rgMbid: string;
        artist: { name: string; mbid: string | null };
    };
    /** Set on tracks added as familiar anchors rather than discoveries. */
    isLibraryAnchor?: boolean;
}

/** An album Discover acquired and now needs the tracks of. */
export interface AlbumCriteria {
    artistName: string;
    albumTitle: string;
    /** Release-group MBID Discover asked for; the most reliable key. */
    albumMbid: string;
}

/** A single song Discover acquired, in track-first mode. */
export interface TrackCriteria {
    artistName: string;
    trackTitle: string;
    albumTitle?: string;
    albumMbid?: string;
}

/**
 * How long a loaded Jellyfin index is reused. Ownership is checked once per
 * recommendation candidate — hundreds of times per run — so re-reading the
 * table for each would dominate generation. A few minutes of staleness cannot
 * matter to those checks, since nothing is downloaded until afterwards.
 */
const INDEX_CACHE_MS = 5 * 60 * 1000;

let cachedIndex: { index: JellyfinTrackIndex; loadedAt: number } | null = null;

/**
 * Truncated to match the column and the `track:` convention used for synthetic
 * download-job MBIDs elsewhere.
 */
function syntheticAlbumMbid(artistName: string, albumTitle: string): string {
    return `album:${artistName}:${albumTitle}`.toLowerCase().slice(0, 180);
}

/** Stable grouping key for a Jellyfin album that carries no release MBID. */
function jellyfinAlbumKey(entry: JellyfinLibraryEntry): string {
    if (entry.rgMbid) return entry.rgMbid;
    const artist = artistLookupKey(entry.artistName);
    const album = entry.albumTitle
        ? normalizeAlbumForMatching(entry.albumTitle).toLowerCase()
        : "";
    return `jellyfin-album:${artist}|${album}`;
}

/**
 * Map a Jellyfin entry onto the shape the playlist builder expects.
 *
 * `preferredMbid` is the release-group MBID Discover asked for. It is used only
 * when Jellyfin recorded none of its own, so that tracks of one album still
 * collapse to a single DiscoveryAlbum.
 */
function toLibraryTrack(
    entry: JellyfinLibraryEntry,
    preferredMbid?: string
): LibraryTrackRef {
    const albumTitle = entry.albumTitle ?? "";
    return {
        id: entry.jellyfinId,
        title: entry.trackTitle,
        filePath: "",
        album: {
            id: jellyfinAlbumKey(entry),
            title: albumTitle,
            rgMbid:
                entry.rgMbid ||
                preferredMbid ||
                syntheticAlbumMbid(entry.artistName, albumTitle),
            artist: { name: entry.artistName, mbid: entry.artistMbid ?? null },
        },
    };
}

const NATIVE_TRACK_INCLUDE = {
    album: { include: { artist: true } },
} as const;

/**
 * Reads a library for the duration of one operation.
 *
 * Created per operation so a Jellyfin index is loaded at most once per Discover
 * run rather than per question asked of it.
 */
export interface LibraryReader {
    /** Whether this is reading Jellyfin rather than the local scan tables. */
    readonly isJellyfin: boolean;
    /**
     * Tracks indexed, when reading Jellyfin. Zero means the metadata sync has
     * never run, which is worth reporting rather than silently matching nothing.
     */
    readonly size: number;

    /** Every track of each named album that is present in the library. */
    findAlbumTracks(criteria: AlbumCriteria[]): Promise<LibraryTrackRef[]>;
    /** The single best match for each named song present in the library. */
    findTracks(criteria: TrackCriteria[]): Promise<LibraryTrackRef[]>;
    /** Whether the library holds anything by this artist. */
    isArtistOwned(name: string, mbid?: string | null): Promise<boolean>;
    /**
     * Whether the library holds this album. Either the names or the MBID may be
     * omitted; callers that only resolved one of the two pass null for the rest.
     */
    isAlbumOwned(
        artistName: string | null,
        albumTitle: string | null,
        rgMbid?: string | null
    ): Promise<boolean>;
    /**
     * Of these artists, the ones the library does not already hold. Batched
     * because recommendation shelves ask about a whole page at once.
     */
    unownedArtists<T extends ArtistRef>(candidates: T[]): Promise<T[]>;
    /**
     * Whether the library holds each album, lined up with the input.
     *
     * The native reader matches on release MBID alone, as this has always done.
     * The Jellyfin reader also falls back to artist and album title, because
     * plenty of Jellyfin libraries carry no MusicBrainz IDs at all.
     */
    ownedAlbums(candidates: AlbumOwnershipQuery[]): Promise<boolean[]>;
    /**
     * Familiar tracks to mix in among the discoveries, at most one per album.
     *
     * Restricted to `artistNames`/`artistMbids` when given, so the anchors are
     * by acts the user actually listens to; otherwise drawn from anywhere in the
     * library.
     */
    findAnchorTracks(opts: AnchorQuery): Promise<LibraryTrackRef[]>;
}

/** A recommended artist, as the shelves know them. */
export interface ArtistRef {
    /** Native artist id, or an MBID or bare name for a Last.fm suggestion. */
    id: string;
    name: string;
    mbid?: string | null;
}

/** An album a shelf wants to mark as already in the library. */
export interface AlbumOwnershipQuery {
    artistName: string;
    albumTitle: string;
    rgMbid?: string | null;
}

/** Which familiar tracks may be used, and which are already spoken for. */
export interface AnchorQuery {
    artistNames?: string[];
    artistMbids?: string[];
    excludeTrackIds: Set<string>;
    excludeAlbumIds: Set<string>;
    limit: number;
}

/** Keep at most one track per album, preserving input order. */
function onePerAlbum(tracks: LibraryTrackRef[], taken: Set<string>) {
    const picked = new Map<string, LibraryTrackRef>();
    for (const track of tracks) {
        const albumId = track.album.id;
        if (!picked.has(albumId) && !taken.has(albumId)) {
            picked.set(albumId, track);
        }
    }
    return [...picked.values()];
}

class JellyfinLibraryReader implements LibraryReader {
    readonly isJellyfin = true;

    constructor(private readonly index: JellyfinTrackIndex) {}

    get size(): number {
        return this.index.size;
    }

    async findAlbumTracks(
        criteria: AlbumCriteria[]
    ): Promise<LibraryTrackRef[]> {
        const found: LibraryTrackRef[] = [];

        for (const wanted of criteria) {
            const entries = lookupJellyfinAlbum(this.index, {
                artist: wanted.artistName,
                album: wanted.albumTitle,
                rgMbid: wanted.albumMbid || null,
            });

            if (entries.length === 0) {
                logger.debug(
                    `     [MISS] No Jellyfin tracks for "${wanted.albumTitle}" by "${wanted.artistName}"`
                );
                continue;
            }

            logger.debug(
                `     [JELLYFIN] Found ${entries.length} tracks for "${wanted.albumTitle}"`
            );
            found.push(
                ...entries.map((entry) =>
                    toLibraryTrack(entry, wanted.albumMbid)
                )
            );
        }

        return found;
    }

    async findTracks(criteria: TrackCriteria[]): Promise<LibraryTrackRef[]> {
        const found: LibraryTrackRef[] = [];

        for (const wanted of criteria) {
            const match = lookupJellyfinTrack(this.index, {
                artist: wanted.artistName,
                title: wanted.trackTitle,
                album: wanted.albumTitle ?? null,
            });

            if (!match) {
                logger.debug(
                    `     [MISS] No Jellyfin track for "${wanted.trackTitle}" by "${wanted.artistName}"`
                );
                continue;
            }

            logger.debug(
                `     [JELLYFIN] Matched "${wanted.trackTitle}" by "${wanted.artistName}" (${match.matchType}, ${match.confidence})`
            );
            found.push(toLibraryTrack(match.entry, wanted.albumMbid));
        }

        return found;
    }

    async isArtistOwned(name: string): Promise<boolean> {
        return this.holdsArtist(name);
    }

    /**
     * Both spellings are tried so that a leading article matches in either
     * direction: the index carries each artist under their name and its
     * article-stripped form, but the name asked about may be the one with the
     * article ("The Slackers" against a library that says "Slackers").
     */
    private holdsArtist(name: string): boolean {
        if (!name) return false;
        const keys = new Set([
            artistLookupKey(name),
            artistKeyWithoutArticle(name),
        ]);
        for (const key of keys) {
            if (key && (this.index.byArtist.get(key)?.length ?? 0) > 0) {
                return true;
            }
        }
        return false;
    }

    async unownedArtists<T extends ArtistRef>(candidates: T[]): Promise<T[]> {
        // Jellyfin records no dependable artist MBID, so this goes by name.
        return candidates.filter((artist) => !this.holdsArtist(artist.name));
    }

    async ownedAlbums(candidates: AlbumOwnershipQuery[]): Promise<boolean[]> {
        return candidates.map(
            (album) =>
                lookupJellyfinAlbum(this.index, {
                    artist: album.artistName,
                    album: album.albumTitle,
                    rgMbid: album.rgMbid ?? null,
                }).length > 0
        );
    }

    async isAlbumOwned(
        artistName: string | null,
        albumTitle: string | null,
        rgMbid?: string | null
    ): Promise<boolean> {
        return (
            lookupJellyfinAlbum(this.index, {
                artist: artistName ?? "",
                album: albumTitle ?? "",
                rgMbid: rgMbid ?? null,
            }).length > 0
        );
    }

    async findAnchorTracks(opts: AnchorQuery): Promise<LibraryTrackRef[]> {
        const names = opts.artistNames ?? [];
        let candidates: JellyfinLibraryEntry[];

        if (names.length > 0) {
            // Jellyfin metadata carries no artist MBID reliably, so the named
            // artists are matched by key. Each entry is indexed under several
            // keys, so the same track can arrive more than once.
            const seen = new Set<string>();
            candidates = [];
            for (const name of names) {
                for (const entry of this.index.byArtist.get(
                    artistLookupKey(name)
                ) ?? []) {
                    if (seen.has(entry.jellyfinId)) continue;
                    seen.add(entry.jellyfinId);
                    candidates.push(entry);
                }
            }
        } else {
            candidates = this.index.entries;
        }

        const eligible = candidates
            .filter((entry) => !opts.excludeTrackIds.has(entry.jellyfinId))
            .map((entry) => toLibraryTrack(entry));

        return onePerAlbum(eligible, opts.excludeAlbumIds).slice(0, opts.limit);
    }
}

class NativeLibraryReader implements LibraryReader {
    readonly isJellyfin = false;
    readonly size = 0;

    async findAlbumTracks(
        criteria: AlbumCriteria[]
    ): Promise<LibraryTrackRef[]> {
        const found: LibraryTrackRef[] = [];

        for (const wanted of criteria) {
            let tracks: any[] = [];

            // The release-group MBID identifies the album regardless of how its
            // title is spelled, so it is tried first.
            if (wanted.albumMbid) {
                tracks = await prisma.track.findMany({
                    where: { album: { rgMbid: wanted.albumMbid } },
                    include: NATIVE_TRACK_INCLUDE,
                });
                if (tracks.length > 0) {
                    logger.debug(
                        `     [MBID] Found ${tracks.length} tracks for "${wanted.albumTitle}"`
                    );
                }
            }

            if (tracks.length === 0) {
                tracks = await prisma.track.findMany({
                    where: {
                        album: {
                            title: {
                                equals: wanted.albumTitle,
                                mode: "insensitive",
                            },
                            artist: {
                                name: {
                                    equals: wanted.artistName,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    include: NATIVE_TRACK_INCLUDE,
                });
                if (tracks.length > 0) {
                    logger.debug(
                        `     [NAME] Found ${tracks.length} tracks for "${wanted.albumTitle}"`
                    );
                }
            }

            // Last resort for titles that differ by punctuation or accents.
            if (tracks.length === 0) {
                tracks = await this.findByNormalizedName(wanted);
            }

            if (tracks.length === 0) {
                logger.debug(
                    `     [MISS] No tracks found for "${wanted.albumTitle}" by "${wanted.artistName}"`
                );
            }

            found.push(...tracks);
        }

        return found;
    }

    private async findByNormalizedName(wanted: AlbumCriteria): Promise<any[]> {
        const normalize = (s: string) =>
            s
                .toLowerCase()
                .normalize("NFKD")
                .replace(/[\u0300-\u036f]/g, "")
                .replace(/[^\w\s]/g, " ")
                .replace(/\s+/g, " ")
                .trim();

        const normalizedAlbum = normalize(wanted.albumTitle);
        const normalizedArtist = normalize(wanted.artistName);

        const artistAlbums = await prisma.album.findMany({
            where: {
                artist: {
                    name: {
                        mode: "insensitive",
                        contains: normalizedArtist.split(" ")[0],
                    },
                },
            },
            include: { artist: true, tracks: true },
        });

        for (const album of artistAlbums) {
            const normalizedTitle = normalize(album.title);
            if (
                normalizedTitle === normalizedAlbum ||
                normalizedTitle.includes(normalizedAlbum) ||
                normalizedAlbum.includes(normalizedTitle)
            ) {
                const tracks = album.tracks.map((t: any) => ({
                    ...t,
                    album: { ...album, artist: album.artist },
                }));
                if (tracks.length > 0) {
                    logger.debug(
                        `     [NORMALIZED] Found ${tracks.length} tracks for "${wanted.albumTitle}"`
                    );
                    return tracks;
                }
            }
        }

        return [];
    }

    async findTracks(criteria: TrackCriteria[]): Promise<LibraryTrackRef[]> {
        const found: LibraryTrackRef[] = [];

        for (const wanted of criteria) {
            let tracks = await prisma.track.findMany({
                where: {
                    title: { equals: wanted.trackTitle, mode: "insensitive" },
                    album: {
                        artist: {
                            name: {
                                equals: wanted.artistName,
                                mode: "insensitive",
                            },
                        },
                    },
                },
                include: NATIVE_TRACK_INCLUDE,
                take: 1,
            });

            // Partial title against the artist's first word.
            if (tracks.length === 0) {
                tracks = await prisma.track.findMany({
                    where: {
                        title: {
                            contains: wanted.trackTitle,
                            mode: "insensitive",
                        },
                        album: {
                            artist: {
                                name: {
                                    contains: wanted.artistName.split(" ")[0],
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    include: NATIVE_TRACK_INCLUDE,
                    take: 1,
                });
            }

            if (tracks.length > 0) {
                logger.debug(
                    `     [TRACK] Matched "${wanted.trackTitle}" by "${wanted.artistName}"`
                );
                found.push(...(tracks as any[]));
            } else {
                logger.debug(
                    `     [MISS] No library track for "${wanted.trackTitle}" by "${wanted.artistName}"`
                );
            }
        }

        return found;
    }

    async isArtistOwned(name: string, mbid?: string | null): Promise<boolean> {
        // Owning an artist means holding music by them, so an artist row with no
        // albums does not count — the Jellyfin bridge creates such rows. Asked
        // of the database rather than of the result, or an albumless row could
        // be returned in preference to a populated one.
        if (mbid) {
            const byMbid = await prisma.artist.findFirst({
                where: { mbid, albums: { some: {} } },
                select: { id: true },
            });
            if (byMbid) return true;
        }

        if (!name) return false;

        // Both spellings are tried: normalizedName reconciles punctuation, but
        // it defaults to empty, so rows predating it only match on name.
        const byName = await prisma.artist.findFirst({
            where: {
                OR: [
                    { normalizedName: normalizeArtistName(name) },
                    { name: { equals: name, mode: "insensitive" } },
                ],
                albums: { some: {} },
            },
            select: { id: true },
        });
        return !!byName;
    }

    async isAlbumOwned(
        artistName: string | null,
        albumTitle: string | null,
        rgMbid?: string | null
    ): Promise<boolean> {
        if (rgMbid) {
            const byMbid = await prisma.album.findFirst({
                where: { rgMbid, tracks: { some: {} } },
            });
            if (byMbid) return true;
        }

        if (!artistName || !albumTitle) return false;

        const byName = await prisma.album.findFirst({
            where: {
                title: { contains: albumTitle, mode: "insensitive" },
                artist: { name: { contains: artistName, mode: "insensitive" } },
            },
        });
        return !!byName;
    }

    async unownedArtists<T extends ArtistRef>(candidates: T[]): Promise<T[]> {
        if (candidates.length === 0) return [];

        // Matched on artist id: a suggestion the user owns will have been
        // resolved to its native row upstream, and one that has not is keyed by
        // MBID or name and so cannot collide with an id here.
        const owned = await prisma.album.findMany({
            where: { tracks: { some: {} } },
            select: { artistId: true },
            distinct: ["artistId"],
            take: 50_000,
        });
        const ownedIds = new Set(owned.map((row) => row.artistId));
        return candidates.filter((artist) => !ownedIds.has(artist.id));
    }

    async ownedAlbums(candidates: AlbumOwnershipQuery[]): Promise<boolean[]> {
        const mbids = candidates
            .map((album) => album.rgMbid)
            .filter((mbid): mbid is string => !!mbid);
        if (mbids.length === 0) return candidates.map(() => false);

        const held = await prisma.album.findMany({
            where: { rgMbid: { in: mbids } },
            select: { rgMbid: true },
        });
        const heldMbids = new Set(held.map((album) => album.rgMbid));
        return candidates.map(
            (album) => !!album.rgMbid && heldMbids.has(album.rgMbid)
        );
    }

    async findAnchorTracks(opts: AnchorQuery): Promise<LibraryTrackRef[]> {
        const names = opts.artistNames ?? [];
        const mbids = opts.artistMbids ?? [];
        const restrictToArtists = names.length > 0 || mbids.length > 0;

        const tracks = await prisma.track.findMany({
            where: {
                album: {
                    ...(restrictToArtists
                        ? {
                              artist: {
                                  OR: [
                                      {
                                          normalizedName: {
                                              in: names.map(normalizeArtistName),
                                          },
                                      },
                                      ...(mbids.length > 0
                                          ? [{ mbid: { in: mbids } }]
                                          : []),
                                  ],
                              },
                          }
                        : {}),
                    id: { notIn: [...opts.excludeAlbumIds] },
                },
                id: { notIn: [...opts.excludeTrackIds] },
            },
            include: NATIVE_TRACK_INCLUDE,
            // Ordering by artist gives the unrestricted case some variety
            // rather than whatever the table happens to return first.
            ...(restrictToArtists
                ? {}
                : { orderBy: { album: { artist: { name: "asc" } } } as const }),
            // Over-fetch, since collapsing to one track per album discards most.
            take: opts.limit * 10,
        });

        return onePerAlbum(tracks as any[], opts.excludeAlbumIds).slice(
            0,
            opts.limit
        );
    }
}

/**
 * Open a reader for the library that is currently authoritative.
 *
 * Pass `fresh` when the answer must account for music downloaded moments ago —
 * building the finished playlist, for instance, which runs directly after a
 * Jellyfin scan and metadata sync.
 */
export async function openLibraryReader(
    opts: { fresh?: boolean } = {}
): Promise<LibraryReader> {
    if (!(await isJellyfinMusicSource())) return new NativeLibraryReader();

    const now = Date.now();
    if (
        !opts.fresh &&
        cachedIndex &&
        now - cachedIndex.loadedAt < INDEX_CACHE_MS
    ) {
        return new JellyfinLibraryReader(cachedIndex.index);
    }

    const index = await loadJellyfinTrackIndex();
    cachedIndex = { index, loadedAt: now };
    return new JellyfinLibraryReader(index);
}

/** Drop the cached Jellyfin index, so the next read reflects new music. */
/**
 * Whether the user holds music by this artist, whichever source is in use.
 *
 * Named for the cleanup paths that ask it before deleting an artist from Lidarr
 * with `deleteFiles`, where a wrong answer costs the user their files.
 */
export async function isArtistInUserLibrary(
    name: string,
    mbid?: string | null
): Promise<boolean> {
    const library = await openLibraryReader();
    return library.isArtistOwned(name, mbid);
}

export function invalidateLibraryCache(): void {
    cachedIndex = null;
}
