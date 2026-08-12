import { spotifyService, SpotifyTrack, SpotifyPlaylist } from "./spotify";
import { logger } from "../utils/logger";
import { musicBrainzService } from "./musicbrainz";
import { deezerService } from "./deezer";
import type { YouTubeMusicPlaylist } from "./youtubeMusic";
import {
    createPlaylistLogger,
    logPlaylistEvent,
} from "../utils/playlistLogger";
import { notificationService } from "./notificationService";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import PQueue from "p-queue";
import { acquisitionService } from "./acquisitionService";
import { extractPrimaryArtist } from "../utils/artistNormalization";
import {
    artistLookupFirstWord,
    artistLookupKey,
    normalizeAlbumForMatching,
    normalizeApostrophes,
    normalizeForCompare as normalizeString,
    normalizeTrackTitle,
    stringSimilarity,
    stripTrackSuffix,
} from "../utils/matchKeys";
import { applyTrackEdits, type TrackEdit } from "../utils/trackEdits";
import { syncPlaylistToJellyfin } from "./jellyfinPlaylistMirror";
import {
    deriveImportTrackRows,
    inFlightDownloadIds,
    unmatchedTrackKey,
    type ImportTrackRow,
    type ImportTrackSummary,
} from "./importTrackStatus";
import {
    explainJellyfinMiss,
    loadJellyfinTrackIndex,
    lookupJellyfinTrack,
    type JellyfinTrackIndex,
    type JellyfinTrackMatch,
} from "./jellyfinLibraryIndex";

export type { TrackEdit };

// Store loggers for each job
const jobLoggers = new Map<string, ReturnType<typeof createPlaylistLogger>>();

/**
 * Spotify Import Service
 *
 * Handles matching Spotify tracks to local library and managing imports
 */

export interface MatchedTrack {
    spotifyTrack: SpotifyTrack;
    localTrack: {
        id: string;
        title: string;
        albumId: string;
        albumTitle: string;
        artistName: string;
    } | null;
    matchType: "exact" | "fuzzy" | "none";
    matchConfidence: number; // 0-100
}

export interface AlbumToDownload {
    spotifyAlbumId: string;
    albumName: string;
    artistName: string;
    artistMbid: string | null;
    albumMbid: string | null;
    coverUrl: string | null;
    trackCount: number;
    tracksNeeded: SpotifyTrack[];
}

export type PlaylistSource = "spotify" | "deezer" | "youtube-music";

export interface ImportPreview {
    source: PlaylistSource;
    playlist: {
        id: string;
        name: string;
        description: string | null;
        owner: string;
        imageUrl: string | null;
        trackCount: number;
    };
    matchedTracks: MatchedTrack[];
    albumsToDownload: AlbumToDownload[];
    summary: {
        total: number;
        inLibrary: number;
        downloadable: number;
        notFound: number;
    };
    /**
     * Set when the library could not be consulted properly, so a zero
     * "in library" count reflects a broken lookup rather than a missing
     * library. Shown to the user so they don't re-download what they own.
     */
    libraryWarning?: string;
}

export interface ImportJob {
    id: string;
    userId: string;
    spotifyPlaylistId: string;
    playlistName: string;
    status:
        | "pending"
        | "downloading"
        | "scanning"
        | "creating_playlist"
        | "matching_tracks"
        | "completed"
        | "failed"
        | "cancelled";
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number; // Tracks from albums being downloaded
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    // Store the original track list so we can match after downloads
    pendingTracks: Array<{
        artist: string;
        title: string;
        album: string;
        albumMbid: string | null;
        artistMbid: string | null;
        preMatchedTrackId: string | null; // Track ID if already matched in preview
    }>;
}

/**
 * Everything about an import job except the pendingTracks payload, which is far
 * too large to ship to a client that only wants to show progress.
 */
const IMPORT_JOB_SUMMARY_SELECT = {
    id: true,
    spotifyPlaylistId: true,
    playlistName: true,
    status: true,
    progress: true,
    albumsTotal: true,
    albumsCompleted: true,
    tracksMatched: true,
    tracksTotal: true,
    tracksDownloadable: true,
    createdPlaylistId: true,
    error: true,
    createdAt: true,
    updatedAt: true,
} as const;

/**
 * Statuses in which an import is still doing work. Everything else is terminal.
 */
export const ACTIVE_IMPORT_STATUSES = [
    "pending",
    "downloading",
    "scanning",
    "creating_playlist",
    "matching_tracks",
] as const;

/**
 * An import that goes this long without writing a status update is treated as
 * dead rather than in-flight, so a job orphaned by a restart can't linger as a
 * permanent spinner. Mirrors the stale-cleanup threshold in staleJobCleanup.
 */
const ACTIVE_IMPORT_MAX_IDLE_MS = 2 * 60 * 60 * 1000;

/**
 * An import job without the pendingTracks payload, which can run to thousands
 * of entries and has no business in a response the client polls.
 */
export type ActiveImportJob = Omit<ImportJob, "pendingTracks" | "userId">;

// Redis key pattern for import jobs
const IMPORT_JOB_KEY = (id: string) => `import:job:${id}`;
const IMPORT_JOB_TTL = 24 * 60 * 60; // 24 hours

/**
 * Save import job to both database and Redis cache for cross-process sharing
 */
async function saveImportJob(job: ImportJob): Promise<void> {
    // Save to database for durability
    await prisma.spotifyImportJob.upsert({
        where: { id: job.id },
        create: {
            id: job.id,
            userId: job.userId,
            spotifyPlaylistId: job.spotifyPlaylistId,
            playlistName: job.playlistName,
            status: job.status,
            progress: job.progress,
            albumsTotal: job.albumsTotal,
            albumsCompleted: job.albumsCompleted,
            tracksMatched: job.tracksMatched,
            tracksTotal: job.tracksTotal,
            tracksDownloadable: job.tracksDownloadable,
            createdPlaylistId: job.createdPlaylistId,
            error: job.error,
            pendingTracks: job.pendingTracks as any,
        },
        update: {
            status: job.status,
            progress: job.progress,
            albumsCompleted: job.albumsCompleted,
            tracksMatched: job.tracksMatched,
            createdPlaylistId: job.createdPlaylistId,
            error: job.error,
            updatedAt: new Date(),
        },
    });

    // Save to Redis for cross-process sharing
    try {
        await redisClient.setEx(
            IMPORT_JOB_KEY(job.id),
            IMPORT_JOB_TTL,
            JSON.stringify(job)
        );
    } catch (error) {
        logger?.warn(
            `⚠️  Failed to cache import job ${job.id} in Redis:`,
            error
        );
        // Continue - Redis is optional, DB is source of truth
    }
}

/**
 * Get import job from Redis cache or database
 * Redis provides cross-process sharing between API and worker processes
 */
async function getImportJob(importJobId: string): Promise<ImportJob | null> {
    // Try Redis cache first (shared across all processes)
    try {
        const cached = await redisClient.get(IMPORT_JOB_KEY(importJobId));
        if (cached) {
            return JSON.parse(cached);
        }
    } catch (error) {
        logger?.warn(
            `⚠️  Failed to read import job ${importJobId} from Redis:`,
            error
        );
        // Fall through to DB
    }

    // Load from database as fallback
    const dbJob = await prisma.spotifyImportJob.findUnique({
        where: { id: importJobId },
    });

    if (!dbJob) return null;

    // Convert database job to ImportJob format
    const job: ImportJob = {
        id: dbJob.id,
        userId: dbJob.userId,
        spotifyPlaylistId: dbJob.spotifyPlaylistId,
        playlistName: dbJob.playlistName,
        status: dbJob.status as ImportJob["status"],
        progress: dbJob.progress,
        albumsTotal: dbJob.albumsTotal,
        albumsCompleted: dbJob.albumsCompleted,
        tracksMatched: dbJob.tracksMatched,
        tracksTotal: dbJob.tracksTotal,
        tracksDownloadable: dbJob.tracksDownloadable,
        createdPlaylistId: dbJob.createdPlaylistId,
        error: dbJob.error,
        createdAt: dbJob.createdAt,
        updatedAt: dbJob.updatedAt,
        pendingTracks: (dbJob.pendingTracks as any) || [],
    };

    // Populate Redis for next time
    try {
        await redisClient.setEx(
            IMPORT_JOB_KEY(importJobId),
            IMPORT_JOB_TTL,
            JSON.stringify(job)
        );
    } catch (error) {
        logger?.warn(
            `⚠️  Failed to cache import job ${importJobId} in Redis:`,
            error
        );
        // Continue - Redis is optional
    }

    return job;
}

class SpotifyImportService {
    /**
     * Load the Jellyfin library index, but only when Jellyfin is actually the
     * music source. Returns null in native mode so callers fall through to the
     * Prisma matching path.
     */
    private async loadJellyfinIndexIfSource(
        logPrefix: string
    ): Promise<JellyfinTrackIndex | null> {
        try {
            const { isJellyfinMusicSource } = await import("./jellyfin");
            if (!(await isJellyfinMusicSource())) return null;

            const index = await loadJellyfinTrackIndex();
            logger?.info(
                `${logPrefix} Matching against ${index.size} Jellyfin library track(s)`
            );
            return index;
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : String(error);
            logger?.error(
                `${logPrefix} Could not load the Jellyfin library index: ${message}`
            );
            // Matching against nothing would report the whole playlist as
            // missing and re-download it, so surface this rather than degrade.
            throw error;
        }
    }

    /**
     * Bring Jellyfin and its metadata cache up to date before re-matching, so a
     * just-downloaded track can actually be found. Best effort: a re-check
     * against a slightly stale index is still better than failing outright.
     */
    private async refreshJellyfinBeforeRematch(logger?: {
        warn: (message: string) => void;
    }): Promise<void> {
        try {
            const {
                isJellyfinMusicSource,
                getJellyfinConfig,
                triggerJellyfinLibraryRefresh,
                waitForJellyfinLibraryScan,
            } = await import("./jellyfin");

            if (!(await isJellyfinMusicSource())) return;

            const cfg = await getJellyfinConfig();
            if (cfg) {
                await triggerJellyfinLibraryRefresh(cfg);
                await waitForJellyfinLibraryScan(cfg, { timeoutMs: 60_000 });
            }

            const { syncRecentJellyfinTracks } = await import(
                "./jellyfinMetadataSync"
            );
            await syncRecentJellyfinTracks();
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : String(error);
            logger?.warn(
                `Could not refresh Jellyfin before re-matching: ${message}`
            );
        }
    }

    /**
     * Look a track up in the Jellyfin library index.
     *
     * Tries the full artist credit first, then the primary artist, so
     * "A feat. B" finds a library copy filed under either spelling.
     */
    private lookupInJellyfin(
        index: JellyfinTrackIndex,
        track: { artist: string; title: string; album?: string | null }
    ): JellyfinTrackMatch | null {
        const primaryArtist = extractPrimaryArtist(track.artist);
        const candidateArtists =
            primaryArtist === track.artist
                ? [track.artist]
                : [track.artist, primaryArtist];

        for (const artist of candidateArtists) {
            const match = lookupJellyfinTrack(index, {
                artist,
                title: track.title,
                album: track.album,
            });
            if (match) return match;
        }

        return null;
    }

    /**
     * Match a source track against the Jellyfin library index.
     */
    private matchTrackAgainstJellyfin(
        spotifyTrack: SpotifyTrack,
        index: JellyfinTrackIndex
    ): MatchedTrack {
        const match = this.lookupInJellyfin(index, spotifyTrack);

        if (!match) {
            return {
                spotifyTrack,
                localTrack: null,
                matchType: "none",
                matchConfidence: 0,
            };
        }

        return {
            spotifyTrack,
            localTrack: {
                // Usable as a PlaylistItem.trackId as-is; those are resolved
                // against Jellyfin at read time.
                id: match.entry.jellyfinId,
                title: match.entry.trackTitle,
                albumId: match.entry.rgMbid ? `mbid:${match.entry.rgMbid}` : "",
                albumTitle: match.entry.albumTitle ?? spotifyTrack.album,
                artistName: match.entry.artistName,
            },
            matchType: match.matchType,
            matchConfidence: match.confidence,
        };
    }

    /**
     * Match a source track to the local library.
     *
     * With Jellyfin as the music source the library lives in Jellyfin and its
     * local index is JellyfinTrackMetadata, so matching goes through the
     * supplied index. In native mode it walks the Prisma tables:
     * 1. Exact match: artist + album + title (case-insensitive)
     * 2. Normalized album match: artist + normalized album + title
     * 3. Artist + title only: for "Unknown Album" or when album match fails
     * 4. Fuzzy match: similarity-based matching across all tracks by artist
     */
    private async matchTrack(
        spotifyTrack: SpotifyTrack,
        jellyfinIndex?: JellyfinTrackIndex | null
    ): Promise<MatchedTrack> {
        if (jellyfinIndex) {
            return this.matchTrackAgainstJellyfin(spotifyTrack, jellyfinIndex);
        }

        const normalizedTitle = normalizeString(spotifyTrack.title);
        const normalizedArtist = normalizeString(spotifyTrack.artist);
        const cleanedTrackTitle = normalizeTrackTitle(spotifyTrack.title);

        // Extract primary artist for better matching (handles "Artist feat. Someone")
        const primaryArtist = extractPrimaryArtist(spotifyTrack.artist);
        const normalizedPrimaryArtist = normalizeString(primaryArtist);

        // Separate keys for querying artist.normalizedName. The normalizeString
        // values above stay for in-memory similarity scoring, where both sides
        // get the same treatment.
        const primaryArtistKey = artistLookupKey(primaryArtist);
        const artistKey = artistLookupKey(spotifyTrack.artist);

        // Normalize album title (strip edition/remaster suffixes)
        const cleanedAlbum = normalizeAlbumForMatching(spotifyTrack.album);
        const isUnknownAlbum = spotifyTrack.album === "Unknown Album" || !spotifyTrack.album;

        // Strategy 1: Exact match by primary artist + album + title
        let exactMatch = await prisma.track.findFirst({
            where: {
                album: {
                    artist: {
                        normalizedName: primaryArtistKey,
                    },
                    title: {
                        mode: "insensitive",
                        equals: spotifyTrack.album,
                    },
                },
                title: {
                    mode: "insensitive",
                    equals: spotifyTrack.title,
                },
            },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
        });

        // Strategy 1b: Try with full artist name if primary artist didn't match
        if (!exactMatch && primaryArtist !== spotifyTrack.artist) {
            exactMatch = await prisma.track.findFirst({
                where: {
                    album: {
                        artist: {
                            normalizedName: artistKey,
                        },
                        title: {
                            mode: "insensitive",
                            equals: spotifyTrack.album,
                        },
                    },
                    title: {
                        mode: "insensitive",
                        equals: spotifyTrack.title,
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
            });
        }

        if (exactMatch) {
            return {
                spotifyTrack,
                localTrack: {
                    id: exactMatch.id,
                    title: exactMatch.title,
                    albumId: exactMatch.albumId,
                    albumTitle: exactMatch.album.title,
                    artistName: exactMatch.album.artist.name,
                },
                matchType: "exact",
                matchConfidence: 100,
            };
        }

        // Strategy 2: Normalized album match (handles "Album (Deluxe Edition)" vs "Album")
        // Only try if album is not unknown and differs from cleaned version
        if (!isUnknownAlbum && cleanedAlbum !== spotifyTrack.album) {
            let normalizedAlbumMatch = await prisma.track.findFirst({
                where: {
                    album: {
                        artist: {
                            normalizedName: primaryArtistKey,
                        },
                        title: {
                            mode: "insensitive",
                            startsWith: cleanedAlbum,
                        },
                    },
                    title: {
                        mode: "insensitive",
                        equals: spotifyTrack.title,
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
            });

            // Also try: DB album starts with Spotify album (handles Spotify having shorter name)
            if (!normalizedAlbumMatch) {
                // Get all albums by this artist and check if any starts with the cleaned album name
                const artistAlbums = await prisma.album.findMany({
                    where: {
                        artist: {
                            normalizedName: primaryArtistKey,
                        },
                    },
                    include: {
                        tracks: true,
                        artist: true,
                    },
                });

                for (const album of artistAlbums) {
                    const dbAlbumCleaned = normalizeAlbumForMatching(album.title);
                    // Check if album names match after normalization
                    if (
                        dbAlbumCleaned.toLowerCase() === cleanedAlbum.toLowerCase() ||
                        dbAlbumCleaned.toLowerCase().startsWith(cleanedAlbum.toLowerCase()) ||
                        cleanedAlbum.toLowerCase().startsWith(dbAlbumCleaned.toLowerCase())
                    ) {
                        // Find matching track in this album
                        const matchingTrack = album.tracks.find(
                            (t) => t.title.toLowerCase() === spotifyTrack.title.toLowerCase() ||
                                   normalizeTrackTitle(t.title) === cleanedTrackTitle
                        );
                        if (matchingTrack) {
                            return {
                                spotifyTrack,
                                localTrack: {
                                    id: matchingTrack.id,
                                    title: matchingTrack.title,
                                    albumId: album.id,
                                    albumTitle: album.title,
                                    artistName: album.artist.name,
                                },
                                matchType: "exact",
                                matchConfidence: 95,
                            };
                        }
                    }
                }
            }

            if (normalizedAlbumMatch) {
                return {
                    spotifyTrack,
                    localTrack: {
                        id: normalizedAlbumMatch.id,
                        title: normalizedAlbumMatch.title,
                        albumId: normalizedAlbumMatch.albumId,
                        albumTitle: normalizedAlbumMatch.album.title,
                        artistName: normalizedAlbumMatch.album.artist.name,
                    },
                    matchType: "exact",
                    matchConfidence: 95,
                };
            }
        }

        // Strategy 3: Artist + title match (ignores album - for "Unknown Album" tracks)
        // This catches tracks where the album metadata is missing from Spotify/Deezer
        const artistTitleMatches = await prisma.track.findMany({
            where: {
                album: {
                    artist: {
                        normalizedName: primaryArtistKey,
                    },
                },
                OR: [
                    { title: { mode: "insensitive", equals: spotifyTrack.title } },
                    { title: { mode: "insensitive", equals: cleanedTrackTitle } },
                ],
            },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
            take: 10,
        });

        // Also try with full artist name
        if (artistTitleMatches.length === 0 && primaryArtist !== spotifyTrack.artist) {
            const fullArtistMatches = await prisma.track.findMany({
                where: {
                    album: {
                        artist: {
                            normalizedName: artistKey,
                        },
                    },
                    OR: [
                        { title: { mode: "insensitive", equals: spotifyTrack.title } },
                        { title: { mode: "insensitive", equals: cleanedTrackTitle } },
                    ],
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
                take: 10,
            });
            artistTitleMatches.push(...fullArtistMatches);
        }

        if (artistTitleMatches.length > 0) {
            // If we have an album hint (not Unknown), prefer tracks from matching album
            if (!isUnknownAlbum) {
                const albumMatch = artistTitleMatches.find((t) => {
                    const dbAlbumCleaned = normalizeAlbumForMatching(t.album.title).toLowerCase();
                    const spotifyAlbumCleaned = cleanedAlbum.toLowerCase();
                    return dbAlbumCleaned === spotifyAlbumCleaned ||
                           dbAlbumCleaned.includes(spotifyAlbumCleaned) ||
                           spotifyAlbumCleaned.includes(dbAlbumCleaned);
                });
                if (albumMatch) {
                    return {
                        spotifyTrack,
                        localTrack: {
                            id: albumMatch.id,
                            title: albumMatch.title,
                            albumId: albumMatch.albumId,
                            albumTitle: albumMatch.album.title,
                            artistName: albumMatch.album.artist.name,
                        },
                        matchType: "exact",
                        matchConfidence: 90,
                    };
                }
            }

            // Return first match (artist + title matched)
            const match = artistTitleMatches[0];
            return {
                spotifyTrack,
                localTrack: {
                    id: match.id,
                    title: match.title,
                    albumId: match.albumId,
                    albumTitle: match.album.title,
                    artistName: match.album.artist.name,
                },
                matchType: isUnknownAlbum ? "fuzzy" : "exact",
                matchConfidence: isUnknownAlbum ? 85 : 90,
            };
        }

        // Strategy 4: Fuzzy match by primary artist + title (any album)
        // Use multiple search strategies for better coverage
        let fuzzyMatches: any[] = [];

        // 4a: Search by first word of artist (original strategy)
        const firstWord = artistLookupFirstWord(primaryArtist);
        if (firstWord.length >= 3) {
            fuzzyMatches = await prisma.track.findMany({
                where: {
                    album: {
                        artist: {
                            normalizedName: {
                                contains: firstWord,
                            },
                        },
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
                take: 50,
            });
        }

        // 4b: For single-word artist names or if no matches, try startsWith
        if (fuzzyMatches.length === 0) {
            fuzzyMatches = await prisma.track.findMany({
                where: {
                    album: {
                        artist: {
                            normalizedName: {
                                startsWith: primaryArtistKey.substring(0, Math.min(5, primaryArtistKey.length)),
                            },
                        },
                    },
                },
                include: {
                    album: {
                        include: {
                            artist: true,
                        },
                    },
                },
                take: 50,
            });
        }

        // 4c: Fallback - try with full artist name
        if (fuzzyMatches.length === 0 && primaryArtist !== spotifyTrack.artist) {
            const fullArtistFirstWord = artistLookupFirstWord(
                spotifyTrack.artist
            );
            if (fullArtistFirstWord.length >= 3) {
                fuzzyMatches = await prisma.track.findMany({
                    where: {
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: fullArtistFirstWord,
                                },
                            },
                        },
                    },
                    include: {
                        album: {
                            include: {
                                artist: true,
                            },
                        },
                    },
                    take: 50,
                });
            }
        }

        let bestMatch: any = null;
        let bestScore = 0;

        for (const track of fuzzyMatches) {
            // Use cleaned titles for comparison (strips "- 2011 Remaster", etc.)
            const titleSim = stringSimilarity(
                cleanedTrackTitle,
                normalizeTrackTitle(track.title)
            );
            // Compare against primary artist for better matching
            const artistSim = stringSimilarity(
                normalizedPrimaryArtist,
                normalizeString(track.album.artist.name)
            );

            // Weight: title 60%, artist 40%
            const score = titleSim * 0.6 + artistSim * 0.4;

            if (score > bestScore && score >= 70) {
                bestScore = score;
                bestMatch = track;
            }
        }

        if (bestMatch) {
            return {
                spotifyTrack,
                localTrack: {
                    id: bestMatch!.id,
                    title: bestMatch!.title,
                    albumId: bestMatch!.albumId,
                    albumTitle: bestMatch!.album.title,
                    artistName: bestMatch!.album.artist.name,
                },
                matchType: "fuzzy",
                matchConfidence: Math.round(bestScore),
            };
        }

        return {
            spotifyTrack,
            localTrack: null,
            matchType: "none",
            matchConfidence: 0,
        };
    }

    /**
     * Look up album info from MusicBrainz for downloading
     */
    private async findAlbumMbid(
        artistName: string,
        albumName: string
    ): Promise<{ artistMbid: string | null; albumMbid: string | null }> {
        try {
            // Search for artist first
            const artists = await musicBrainzService.searchArtist(
                artistName,
                5
            );
            if (!artists || artists.length === 0) {
                return { artistMbid: null, albumMbid: null };
            }

            // Find best matching artist
            let bestArtist = artists[0];
            for (const artist of artists) {
                if (
                    normalizeString(artist.name) === normalizeString(artistName)
                ) {
                    bestArtist = artist;
                    break;
                }
            }

            const artistMbid = bestArtist.id;

            // Search for album by this artist
            const releaseGroups = await musicBrainzService.getReleaseGroups(
                artistMbid
            );

            for (const rg of releaseGroups || []) {
                if (stringSimilarity(rg.title, albumName) >= 80) {
                    return { artistMbid, albumMbid: rg.id };
                }
            }

            return { artistMbid, albumMbid: null };
        } catch (error) {
            logger?.error("MusicBrainz lookup error:", error);
            return { artistMbid: null, albumMbid: null };
        }
    }

    /**
     * Enrich tracks with "Unknown Album" by looking up each track in MusicBrainz
     * This happens BEFORE album grouping so tracks get grouped by their actual albums
     *
     * @param tracks - Array of SpotifyTrack objects (mutated in place)
     * @param logPrefix - Prefix for log messages
     * @returns Stats about resolution success
     */
    private async enrichUnknownAlbumsViaMusicBrainz(
        tracks: SpotifyTrack[],
        logPrefix: string
    ): Promise<{
        resolved: number;
        failed: number;
        cached: Map<string, { albumName: string; albumId: string; albumMbid: string }>;
    }> {
        const unknownAlbumTracks = tracks.filter(
            (t) => t.album === "Unknown Album"
        );

        if (unknownAlbumTracks.length === 0) {
            return { resolved: 0, failed: 0, cached: new Map() };
        }

        logger?.info(
            `${logPrefix} Resolving ${unknownAlbumTracks.length} tracks with Unknown Album via MusicBrainz...`
        );

        // Cache to avoid duplicate lookups for same artist+title
        const resolutionCache = new Map<
            string,
            { albumName: string; albumId: string; albumMbid: string } | null
        >();
        // Results cache for use in album grouping
        const resultsCache = new Map<
            string,
            { albumName: string; albumId: string; albumMbid: string }
        >();

        let resolved = 0;
        let failed = 0;

        // Process tracks (MusicBrainz rate limiting is handled by musicBrainzService)
        for (const track of unknownAlbumTracks) {
            const cacheKey = `${track.artist.toLowerCase()}|||${track.title.toLowerCase()}`;

            // Check if we already looked this up
            if (resolutionCache.has(cacheKey)) {
                const cached = resolutionCache.get(cacheKey);
                if (cached) {
                    track.album = cached.albumName;
                    // NOTE: Using albumId field with 'mbid:' prefix to carry MusicBrainz ID
                    // This is parsed later in buildPreviewFromTracklist() and startImport()
                    track.albumId = `mbid:${cached.albumMbid}`;
                    resolved++;
                    logger?.debug(
                        `${logPrefix} [Cache Hit] "${track.title}" -> "${cached.albumName}"`
                    );
                } else {
                    failed++;
                }
                continue;
            }

            // Normalize track title (remove remaster/live suffixes)
            const normalizedTitle = stripTrackSuffix(track.title);

            try {
                logger?.debug(
                    `${logPrefix} Looking up: "${track.title}" by ${track.artist}...`
                );

                const recordingInfo = await musicBrainzService.searchRecording(
                    normalizedTitle,
                    track.artist
                );

                if (recordingInfo && recordingInfo.albumName) {
                    // Success - update track with resolved album
                    track.album = recordingInfo.albumName;
                    // NOTE: Using albumId field with 'mbid:' prefix to carry MusicBrainz ID
                    // This is parsed later in buildPreviewFromTracklist() and startImport()
                    track.albumId = `mbid:${recordingInfo.albumMbid}`;

                    const result = {
                        albumName: recordingInfo.albumName,
                        albumId: recordingInfo.albumMbid,
                        albumMbid: recordingInfo.albumMbid,
                    };

                    resolutionCache.set(cacheKey, result);
                    resultsCache.set(track.spotifyId, result);
                    resolved++;

                    logger?.info(
                        `${logPrefix} Resolved: "${track.title}" -> "${recordingInfo.albumName}"`
                    );
                } else {
                    // Failed - track stays as "Unknown Album"
                    resolutionCache.set(cacheKey, null);
                    failed++;
                    logger?.debug(
                        `${logPrefix} Could not resolve: "${track.title}" by ${track.artist}`
                    );
                }
            } catch (error: unknown) {
                resolutionCache.set(cacheKey, null);
                failed++;
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger?.error(
                    `${logPrefix} Error resolving "${track.title}": ${errorMsg}`
                );
            }
        }

        logger?.info(
            `${logPrefix} MusicBrainz resolution complete: ${resolved} resolved, ${failed} still unknown`
        );

        return { resolved, failed, cached: resultsCache };
    }

    /**
     * Shared preview generator for any source tracklist
     */
    private async buildPreviewFromTracklist(
        tracks: SpotifyTrack[],
        playlistMeta: {
            id: string;
            name: string;
            description: string | null;
            owner: string;
            imageUrl: string | null;
            trackCount: number;
        },
        source: "Spotify" | "Deezer" | "YouTube Music",
        trackEdits?: TrackEdit[]
    ): Promise<ImportPreview> {
        const sourceKey: PlaylistSource =
            source === "Spotify"
                ? "spotify"
                : source === "Deezer"
                ? "deezer"
                : "youtube-music";
        const logPrefix =
            source === "Spotify"
                ? "[Spotify Import]"
                : source === "Deezer"
                ? "[Deezer Import]"
                : "[YouTube Music Import]";

        // Corrections come first: an edited album name should be grouped and
        // looked up as the user typed it, not enriched from the original.
        if (trackEdits?.length) {
            const applied = applyTrackEdits(tracks, trackEdits);
            logger?.info(
                `${logPrefix} Applied ${applied} user metadata correction(s) to the tracklist`
            );
        }

        // PHASE 0: Early MusicBrainz resolution for "Unknown Album" tracks
        // This MUST happen BEFORE grouping so tracks get grouped by actual albums
        const unknownCount = tracks.filter(
            (t) => t.album === "Unknown Album"
        ).length;

        if (unknownCount > 0) {
            logger?.info(
                `${logPrefix} Found ${unknownCount} tracks with Unknown Album, attempting MusicBrainz resolution...`
            );
            try {
                await this.enrichUnknownAlbumsViaMusicBrainz(tracks, logPrefix);
            } catch (error: unknown) {
                const errorMsg = error instanceof Error ? error.message : String(error);
                logger?.error(`${logPrefix} MusicBrainz enrichment failed: ${errorMsg}`);
                // Continue with original tracks - graceful degradation
            }

            // Log remaining unknown after resolution
            const stillUnknown = tracks.filter(
                (t) => t.album === "Unknown Album"
            ).length;
            if (stillUnknown > 0) {
                logger?.info(
                    `${logPrefix} ${stillUnknown} tracks still have Unknown Album after MusicBrainz resolution`
                );
            }
        }

        // With Jellyfin as the music source the Prisma library tables are not a
        // mirror of the library, so matching has to go through Jellyfin's own
        // index. Built once here and reused for every track.
        const jellyfinIndex = await this.loadJellyfinIndexIfSource(logPrefix);

        const matchedTracks: MatchedTrack[] = [];
        const unmatchedByAlbum = new Map<string, SpotifyTrack[]>();

        for (const track of tracks) {
            const matched = await this.matchTrack(track, jellyfinIndex);
            matchedTracks.push(matched);

            // Say why a track the user may well own wasn't found, so a miss can
            // be classified from the log instead of guessed at.
            if (!matched.localTrack && jellyfinIndex) {
                const miss = explainJellyfinMiss(jellyfinIndex, track);
                logger?.info(
                    miss.artistFound
                        ? `${logPrefix} No library match for "${track.title}" by ${
                              track.artist
                          } — artist has ${
                              miss.artistTrackCount
                          } track(s), closest was "${
                              miss.closestTitle ?? "none"
                          }" at ${miss.closestScore}%`
                        : `${logPrefix} No library match for "${track.title}" by ${track.artist} — that artist is not in the Jellyfin library at all`
                );
            }

            if (!matched.localTrack) {
                // Group on normalized names: keying on the raw ones split
                // "The Slackers" and "the Slackers" into two groups and queued
                // the same album for download twice.
                const key = `${artistLookupKey(
                    track.artist
                )}|||${normalizeAlbumForMatching(track.album).toLowerCase()}`;
                const existing = unmatchedByAlbum.get(key) || [];
                existing.push(track);
                unmatchedByAlbum.set(key, existing);
            }
        }

        const albumsToDownload: AlbumToDownload[] = [];

        for (const albumTracks of unmatchedByAlbum.values()) {
            // Display and lookup use the real names, not the grouping key.
            const artistName = albumTracks[0].artist;
            const albumName = albumTracks[0].album;

            let resolvedAlbumName = albumName;
            let artistMbid: string | null = null;
            let albumMbid: string | null = null;

            // Check if this album was resolved via MusicBrainz (albumId starts with "mbid:")
            const firstTrack = albumTracks[0];
            const wasMbResolved = firstTrack.albumId?.startsWith("mbid:");
            const preResolvedMbid = wasMbResolved
                ? firstTrack.albumId!.replace("mbid:", "")
                : null;

            logger?.debug(
                `\n${logPrefix} ========================================`
            );
            logger?.debug(
                `${logPrefix} Looking up: "${artistName}" - "${albumName}"`
            );

            // If we have MBID from early resolution, use it directly
            if (preResolvedMbid) {
                albumMbid = preResolvedMbid;
                logger?.debug(
                    `${logPrefix} Using pre-resolved MBID: ${albumMbid}`
                );
                // Still get artistMbid for completeness
                const artists = await musicBrainzService.searchArtist(
                    artistName,
                    1
                );
                if (artists && artists.length > 0) {
                    artistMbid = artists[0].id;
                }
            } else if (albumName && albumName !== "Unknown Album") {
                // Normalize album name to remove live/remaster suffixes
                const normalizedAlbumName = stripTrackSuffix(albumName);
                const wasNormalized = normalizedAlbumName !== albumName;

                logger?.debug(
                    `${logPrefix} Searching for album "${albumName}" by ${artistName}...`
                );
                if (wasNormalized) {
                    logger?.debug(
                        `${logPrefix}   → Normalized to: "${normalizedAlbumName}"`
                    );
                }

                const mbResult = await this.findAlbumMbid(
                    artistName,
                    normalizedAlbumName
                );
                artistMbid = mbResult.artistMbid;
                albumMbid = mbResult.albumMbid;

                if (albumMbid) {
                    logger?.debug(
                        `${logPrefix} ✓ Found album directly: "${albumName}" (MBID: ${albumMbid})`
                    );
                }
            }

            if (!albumMbid) {
                logger?.debug(
                    `${logPrefix} Album not found, trying track-based search...`
                );
                for (const track of albumTracks) {
                    // Normalize track title to remove live/remaster suffixes
                    const normalizedTrackTitle = stripTrackSuffix(track.title);
                    const wasNormalized = normalizedTrackTitle !== track.title;

                    logger?.debug(
                        `${logPrefix}   Searching for track "${track.title}"...`
                    );
                    if (wasNormalized) {
                        logger?.debug(
                            `${logPrefix}     → Normalized to: "${normalizedTrackTitle}"`
                        );
                    }

                    const recordingInfo =
                        await musicBrainzService.searchRecording(
                            normalizedTrackTitle,
                            artistName
                        );

                    if (recordingInfo) {
                        resolvedAlbumName = recordingInfo.albumName;
                        artistMbid = recordingInfo.artistMbid;
                        albumMbid = recordingInfo.albumMbid;

                        logger?.debug(
                            `${logPrefix} ✓ Found via track: "${resolvedAlbumName}" (MBID: ${albumMbid})`
                        );
                        break;
                    }
                }
            }

            if (!albumMbid) {
                logger?.debug(
                    `${logPrefix} ✗ Could not find album MBID for ${artistName} - "${resolvedAlbumName}"`
                );
                if (albumName === "Unknown Album") {
                    logger?.debug(
                        `${logPrefix} ℹ But can still download via Soulseek (track-based search)`
                    );
                }
            }

            const albumToDownload: AlbumToDownload = {
                spotifyAlbumId:
                    albumTracks[0].albumId?.replace("mbid:", "") || "",
                albumName: resolvedAlbumName,
                artistName,
                artistMbid,
                albumMbid,
                coverUrl: albumTracks[0].coverUrl,
                trackCount: albumTracks.length,
                tracksNeeded: albumTracks,
            };

            logger?.debug(`${logPrefix} Download strategy:`);
            if (albumMbid) {
                logger?.debug(`   Will request album from Lidarr/Soulseek:`);
                logger?.debug(
                    `   Artist: "${artistName}" (MBID: ${artistMbid || "NONE"})`
                );
                logger?.debug(
                    `   Album: "${resolvedAlbumName}" (MBID: ${albumMbid})`
                );
            } else {
                // No MBID - will try Soulseek track-based search
                logger?.debug(
                    `   Will request individual tracks via Soulseek (no MBID):`
                );
                logger?.debug(`   Artist: "${artistName}"`);
                logger?.debug(
                    `   Tracks: ${albumTracks
                        .map((t) => `"${t.title}"`)
                        .join(", ")}`
                );
            }
            logger?.debug(
                `${logPrefix} ========================================\n`
            );

            albumsToDownload.push(albumToDownload);
        }

        const inLibrary = matchedTracks.filter(
            (m) => m.localTrack !== null
        ).length;

        // All albums are now downloadable via Soulseek (either album-based with MBID or track-based without)
        const downloadableAlbums = albumsToDownload;

        // No albums are truly "not found" since Soulseek can search for any track
        const notFoundAlbums: AlbumToDownload[] = [];

        const downloadable = downloadableAlbums.reduce(
            (sum, a) => sum + a.tracksNeeded.length,
            0
        );
        const notFound = notFoundAlbums.reduce(
            (sum, a) => sum + a.tracksNeeded.length,
            0
        );

        return {
            source: sourceKey,
            playlist: playlistMeta,
            matchedTracks,
            albumsToDownload,
            summary: {
                total: playlistMeta.trackCount,
                inLibrary,
                downloadable,
                notFound,
            },
            libraryWarning:
                jellyfinIndex?.size === 0
                    ? "Your Jellyfin library hasn't been indexed yet, so nothing could be matched against it and every track looks missing. Run \"Sync Jellyfin metadata\" in Settings, then check matches again."
                    : undefined,
        };
    }

    /**
     * Generate a preview of what will be imported
     */
    async generatePreview(
        spotifyUrl: string,
        trackEdits?: TrackEdit[]
    ): Promise<ImportPreview> {
        // Clear any stale null cache entries before processing
        // This ensures we retry previously failed lookups
        await musicBrainzService.clearStaleRecordingCaches();

        const playlist = await spotifyService.getPlaylist(spotifyUrl);
        if (!playlist) {
            throw new Error(
                "Could not fetch playlist from Spotify. Make sure it's a valid public playlist URL."
            );
        }

        return this.buildPreviewFromTracklist(
            playlist.tracks,
            {
                id: playlist.id,
                name: playlist.name,
                description: playlist.description,
                owner: playlist.owner,
                imageUrl: playlist.imageUrl,
                trackCount: playlist.trackCount,
            },
            "Spotify",
            trackEdits
        );
    }

    /**
     * Generate a preview from a Deezer playlist
     * Converts Deezer tracks to Spotify format and processes them
     */
    async generatePreviewFromDeezer(
        deezerPlaylist: any,
        trackEdits?: TrackEdit[]
    ): Promise<ImportPreview> {
        // Clear any stale null cache entries before processing
        await musicBrainzService.clearStaleRecordingCaches();

        logger?.debug(
            "[Deezer Debug] Sample track from Deezer:",
            JSON.stringify(deezerPlaylist.tracks[0], null, 2)
        );

        const spotifyTracks: SpotifyTrack[] = deezerPlaylist.tracks.map(
            (track: any, index: number) => ({
                spotifyId: track.deezerId,
                title: track.title,
                artist: track.artist,
                artistId: track.artistId || "",
                album: track.album || "Unknown Album",
                albumId: track.albumId || "",
                isrc: null,
                durationMs: track.durationMs,
                trackNumber: track.trackNumber || index + 1,
                previewUrl: track.previewUrl || null,
                coverUrl: track.coverUrl || deezerPlaylist.imageUrl || null,
            })
        );

        logger?.debug(
            "[Deezer Debug] Sample converted track:",
            JSON.stringify(spotifyTracks[0], null, 2)
        );

        return this.buildPreviewFromTracklist(
            spotifyTracks,
            {
                id: deezerPlaylist.id,
                name: deezerPlaylist.title,
                description: deezerPlaylist.description || null,
                owner: deezerPlaylist.creator || "Deezer",
                imageUrl: deezerPlaylist.imageUrl || null,
                trackCount: deezerPlaylist.trackCount || spotifyTracks.length,
            },
            "Deezer",
            trackEdits
        );
    }

    /**
     * Generate a preview from a YouTube Music playlist
     * Converts YouTube Music tracks to Spotify format and processes them
     */
    async generatePreviewFromYouTubeMusic(
        ytPlaylist: YouTubeMusicPlaylist,
        trackEdits?: TrackEdit[]
    ): Promise<ImportPreview> {
        await musicBrainzService.clearStaleRecordingCaches();

        const spotifyTracks: SpotifyTrack[] = ytPlaylist.tracks.map(
            (track, index) => ({
                spotifyId: track.youtubeId,
                title: track.title,
                artist: track.artist,
                artistId: "",
                album: track.album || "Unknown Album",
                albumId: "",
                isrc: null,
                durationMs: track.durationMs,
                trackNumber: index + 1,
                previewUrl: null,
                coverUrl: track.coverUrl || ytPlaylist.imageUrl || null,
            })
        );

        return this.buildPreviewFromTracklist(
            spotifyTracks,
            {
                id: ytPlaylist.id,
                name: ytPlaylist.title,
                description: ytPlaylist.description || null,
                owner: ytPlaylist.creator || "YouTube Music",
                imageUrl: ytPlaylist.imageUrl || null,
                trackCount: ytPlaylist.trackCount || spotifyTracks.length,
            },
            "YouTube Music",
            trackEdits
        );
    }

    /**
     * Start an import job
     */
    async startImport(
        userId: string,
        spotifyPlaylistId: string,
        playlistName: string,
        albumMbidsToDownload: string[],
        preview: ImportPreview
    ): Promise<ImportJob> {
        // Validate userId to prevent NaN/invalid values from entering the system
        if (!userId || typeof userId !== 'string' || userId === 'NaN' || userId === 'undefined' || userId === 'null') {
            logger?.error(
                `[Spotify Import] Invalid userId provided to startImport: ${JSON.stringify({
                    userId,
                    typeofUserId: typeof userId,
                    playlistName
                })}`
            );
            throw new Error(`Invalid userId provided: ${userId}`);
        }

        const jobId = `import_${Date.now()}_${Math.random()
            .toString(36)
            .substring(7)}`;

        // Create dedicated logger for this job
        const jobLogger = createPlaylistLogger(jobId);
        jobLoggers.set(jobId, jobLogger);

        jobLogger.logJobStart(playlistName, preview.summary.total, userId);
        jobLogger?.info(`Playlist ID: ${spotifyPlaylistId}`);
        jobLogger?.info(`Albums to download: ${albumMbidsToDownload.length}`);
        jobLogger?.info(`Tracks already in library: ${preview.summary.inLibrary}`);

        // Calculate tracks that will come from downloads
        const tracksFromDownloads = preview.albumsToDownload
            .filter((a) => albumMbidsToDownload.includes(a.albumMbid!))
            .reduce((sum, a) => sum + a.tracksNeeded.length, 0);

        // Extract the track info we need to match after downloads
        // Include ALL tracks, both matched and unmatched
        // IMPORTANT: Store pre-matched track IDs so we don't have to re-search them!
        // NOTE: `PlaylistPendingTrack.spotifyAlbum` should reflect Spotify's album name.
        // Only fall back to a resolved album name when Spotify returns "Unknown Album".
        const pendingTracks = preview.matchedTracks.map((m) => {
            const spotifyAlbum = m.spotifyTrack.album;
            const spotifyAlbumId = m.spotifyTrack.albumId;
            const spotifyArtist = m.spotifyTrack.artist;
            const spotifyTrackId = m.spotifyTrack.spotifyId;
            const trackTitle = m.spotifyTrack.title;

            // Check if album was resolved via MusicBrainz (albumId has mbid: prefix)
            const wasMbResolved = spotifyAlbumId?.startsWith("mbid:");
            const resolvedMbid = wasMbResolved ? spotifyAlbumId.replace("mbid:", "") : null;

            // Try to find album info using multiple strategies
            let albumToDownload: AlbumToDownload | undefined;

            // Strategy 1: Match by resolved MusicBrainz MBID (highest priority for pre-resolved)
            if (resolvedMbid) {
                albumToDownload = preview.albumsToDownload.find(
                    (a) => a.albumMbid === resolvedMbid
                );
            }

            // Strategy 2: Match by Spotify album ID (for non-resolved tracks)
            if (!albumToDownload && spotifyAlbumId && !wasMbResolved) {
                albumToDownload = preview.albumsToDownload.find(
                    (a) => a.spotifyAlbumId === spotifyAlbumId
                );
            }

            // Strategy 3: Find album that contains this specific track in tracksNeeded
            if (!albumToDownload) {
                albumToDownload = preview.albumsToDownload.find((a) =>
                    a.tracksNeeded.some(
                        (t) =>
                            t.spotifyId === spotifyTrackId ||
                            (t.title.toLowerCase() === trackTitle.toLowerCase() &&
                                t.artist.toLowerCase() === spotifyArtist.toLowerCase())
                    )
                );
            }

            // Strategy 4: Match by artist + album name similarity (for edge cases)
            if (!albumToDownload && spotifyArtist && spotifyAlbum && spotifyAlbum !== "Unknown Album") {
                const normalizedArtist = spotifyArtist.toLowerCase();
                const normalizedAlbum = spotifyAlbum.toLowerCase();
                albumToDownload = preview.albumsToDownload.find(
                    (a) =>
                        a.artistName.toLowerCase() === normalizedArtist &&
                        a.albumName.toLowerCase().includes(normalizedAlbum.substring(0, 10))
                );
            }

            // Use resolved album name for display (from track or from albumToDownload)
            const albumForDisplay =
                spotifyAlbum && spotifyAlbum !== "Unknown Album"
                    ? spotifyAlbum
                    : albumToDownload?.albumName || spotifyAlbum;

            // Get the actual MBID (either from pre-resolved or from albumToDownload)
            const actualAlbumMbid = resolvedMbid || albumToDownload?.albumMbid || null;

            return {
                artist: spotifyArtist,
                title: trackTitle,
                album: albumForDisplay,
                albumMbid: actualAlbumMbid,
                artistMbid: albumToDownload?.artistMbid || null,
                preMatchedTrackId: m.localTrack?.id || null,
            };
        });

        const job: ImportJob = {
            id: jobId,
            userId,
            spotifyPlaylistId,
            playlistName,
            status: "pending",
            progress: 0,
            albumsTotal: albumMbidsToDownload.length,
            albumsCompleted: 0,
            tracksMatched: preview.summary.inLibrary,
            tracksTotal: preview.summary.total,
            tracksDownloadable: tracksFromDownloads,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            pendingTracks,
        };

        // Save to database and memory cache
        await saveImportJob(job);

        // Start processing in background
        this.processImport(job, albumMbidsToDownload, preview).catch(
            async (error) => {
                job.status = "failed";
                job.error = error.message;
                job.updatedAt = new Date();
                await saveImportJob(job);
                jobLogger?.logJobFailed(error.message);
                // Clean up job logger to prevent memory leak
                jobLoggers.delete(job.id);
            }
        );

        return job;
    }

    /**
     * Process the import (download albums, create playlist)
     * Now uses AcquisitionService for unified download handling
     */
    private async processImport(
        job: ImportJob,
        albumMbidsToDownload: string[],
        preview: ImportPreview
    ): Promise<void> {
        const logger = jobLoggers.get(job.id);

        try {
            // Phase 1: Download albums using AcquisitionService
            if (albumMbidsToDownload.length > 0) {
                job.status = "downloading";
                job.updatedAt = new Date();
                await saveImportJob(job);

                logger?.logAlbumDownloadStart(albumMbidsToDownload.length);

                logger?.debug(
                    `[Spotify Import] Processing ${albumMbidsToDownload.length} albums via AcquisitionService`
                );
                logger?.info(
                    `Processing ${albumMbidsToDownload.length} albums via AcquisitionService`
                );

                // Process albums in parallel with concurrency limit from settings
                const settings = await getSystemSettings();
                const albumQueue = new PQueue({
                    concurrency: settings?.soulseekConcurrentDownloads || 4,
                });

                const albumPromises = albumMbidsToDownload.map(
                    (albumIdentifier) =>
                        albumQueue.add(async () => {
                            // albumIdentifier can be either albumMbid or spotifyAlbumId (for Unknown Album)
                            const album = preview.albumsToDownload.find(
                                (a) =>
                                    a.albumMbid === albumIdentifier ||
                                    a.spotifyAlbumId === albumIdentifier
                            );
                            if (!album) return;

                            try {
                                const isUnknownAlbum =
                                    album.albumName === "Unknown Album" ||
                                    !album.albumMbid;

                                logger?.info(
                                    `Album start: ${album.artistName} - ${
                                        album.albumName
                                    }${
                                        album.albumMbid
                                            ? ` [MBID: ${album.albumMbid}]`
                                            : " [Unknown Album]"
                                    } (tracksNeeded=${
                                        album.tracksNeeded.length
                                    })`
                                );

                                logger?.debug(
                                    `[Spotify Import] Requesting: ${album.artistName} - ${album.albumName}`
                                );

                                // Validate userId before creating acquisition context
                                if (!job.userId || typeof job.userId !== 'string' || job.userId === 'NaN' || job.userId === 'undefined' || job.userId === 'null') {
                                    logger?.error(
                                        `[Spotify Import] Invalid userId in job: ${JSON.stringify({
                                            jobId: job.id,
                                            userId: job.userId,
                                            typeofUserId: typeof job.userId
                                        })}`
                                    );
                                    throw new Error(`Invalid userId in import job: ${job.userId}`);
                                }

                                // Acquisition context for tracking
                                const context = {
                                    userId: job.userId,
                                    spotifyImportJobId: job.id,
                                };

                                let result;

                                if (isUnknownAlbum) {
                                    // Unknown Album: Use track-based acquisition
                                    logger?.debug(
                                        `[Spotify Import] Unknown Album detected - using track acquisition`
                                    );

                                    const trackRequests =
                                        album.tracksNeeded.map((track) => ({
                                            trackTitle: track.title,
                                            artistName: track.artist,
                                            albumTitle: album.albumName,
                                        }));

                                    const trackResults =
                                        await acquisitionService.acquireTracks(
                                            trackRequests,
                                            context
                                        );

                                    // Check if at least 50% succeeded
                                    const successCount = trackResults.filter(
                                        (r) => r.success
                                    ).length;
                                    const successThreshold = Math.ceil(
                                        trackRequests.length * 0.5
                                    );

                                    result = {
                                        success:
                                            successCount >= successThreshold,
                                        tracksDownloaded: successCount,
                                        tracksTotal: trackRequests.length,
                                    };

                                    if (result.success) {
                                        logger?.info(
                                            `Unknown Album tracks success: ${album.artistName} - ${successCount}/${trackRequests.length} tracks`
                                        );
                                    }
                                } else {
                                    // Regular album: Use album-based acquisition
                                    result =
                                        await acquisitionService.acquireAlbum(
                                            {
                                                albumTitle: album.albumName,
                                                artistName: album.artistName,
                                                mbid: album.albumMbid!,
                                                requestedTracks: album.tracksNeeded.map(t => ({
                                                    title: t.title
                                                })),
                                            },
                                            context
                                        );

                                    if (result.success) {
                                        logger?.info(
                                            `Album acquisition success: ${album.artistName} - ${album.albumName} via ${result.source}`
                                        );
                                    }
                                }

                                if (!result.success) {
                                    const errorMsg =
                                        result.error ||
                                        "No download sources available";
                                    logger?.debug(
                                        `[Spotify Import] ✗ Failed: ${album.albumName} - ${errorMsg}`
                                    );
                                    logger?.logAlbumFailed(
                                        album.albumName,
                                        album.artistName,
                                        errorMsg
                                    );
                                }

                                job.albumsCompleted++;
                                job.progress = Math.round(
                                    (job.albumsCompleted / job.albumsTotal) * 30
                                );
                                job.updatedAt = new Date();
                                await saveImportJob(job);

                                logger?.debug(
                                    `Album done: ${album.artistName} - ${
                                        album.albumName
                                    } (success=${
                                        result.success ? "yes" : "no"
                                    })`
                                );
                            } catch (error: any) {
                                logger?.error(
                                    `[Spotify Import] Failed: ${album.artistName} - ${album.albumName}: ${error.message}`
                                );
                                logger?.logAlbumFailed(
                                    album.albumName,
                                    album.artistName,
                                    error.message
                                );
                            }
                        })
                );

                // Wait for all album acquisitions to complete
                await Promise.all(albumPromises);

                logger?.info(
                    `Initial acquisition phase finished for ${albumMbidsToDownload.length} album(s). Checking completion state...`
                );

                // Check if we can complete immediately
                await this.checkImportCompletion(job.id);

                // Re-fetch job state after checkImportCompletion may have updated it
                const updatedJob = await getImportJob(job.id);
                if (!updatedJob) {
                    logger?.error(`[Spotify Import] Job ${job.id}: Job not found after completion check`);
                    return;
                }

                // If still downloading, wait for completion
                if (updatedJob.status === "downloading") {
                    logger?.debug(
                        `[Spotify Import] Job ${updatedJob.id}: Waiting for downloads to complete...`
                    );
                    logger?.info(`Waiting for downloads to complete...`);
                }
                return;
            }

            // No downloads needed - all tracks already in library
            // Create playlist immediately
            await this.buildPlaylist(job);
        } catch (error: any) {
            job.status = "failed";
            job.error = error.message;
            job.updatedAt = new Date();
            throw error;
        }
    }

    /**
     * Check if all downloads for this import are complete (called by webhook handler)
     */
    async checkImportCompletion(importJobId: string): Promise<void> {
        logger?.debug(
            `\n[Spotify Import] Checking completion for job ${importJobId}...`
        );

        const job = await getImportJob(importJobId);
        if (!job) {
            logger?.debug(`   Job not found`);
            jobLoggers.delete(importJobId);
            return;
        }

        // A download reporting in after the import has already produced its
        // playlist must not drag the job back into "scanning", which it would
        // then never leave because the playlist build is a one-time thing.
        if (job.createdPlaylistId || !ACTIVE_IMPORT_STATUSES.includes(
            job.status as (typeof ACTIVE_IMPORT_STATUSES)[number]
        )) {
            logger?.debug(
                `   Job ${importJobId} is already ${job.status}; nothing to complete`
            );
            return;
        }

        const jobLogger = jobLoggers.get(importJobId);

        // Check download jobs for this import
        // NOTE: Jobs are created with auto-generated CUIDs, not prefixed IDs
        // The spotifyImportJobId is stored in metadata.spotifyImportJobId
        const downloadJobs = await prisma.downloadJob.findMany({
            where: {
                metadata: {
                    path: ['spotifyImportJobId'],
                    equals: importJobId,
                },
            },
        });

        const total = downloadJobs.length;
        const completed = downloadJobs.filter(
            (j) => j.status === "completed"
        ).length;
        const failed = downloadJobs.filter((j) => j.status === "failed").length;
        const pending = total - completed - failed;

        if (total === 0 && job.albumsTotal > 0) {
            const message =
                "No download jobs were created for this import. This usually means the import preview did not include the selected albums.";
            logger?.debug(`   ${message}`);
            jobLogger?.warn(message);

            job.status = "failed";
            job.error = message;
            job.updatedAt = new Date();
            await saveImportJob(job);
            // Clean up job logger to prevent memory leak
            jobLoggers.delete(job.id);
            return;
        }

        logger?.debug(
            `   Download status: ${completed}/${total} completed, ${failed} failed, ${pending} pending`
        );
        jobLogger?.logDownloadProgress(completed, failed, pending);

        // Update progress
        job.progress =
            total > 0
                ? 30 + Math.round((completed / total) * 40) // 30-70% for downloads
                : 30;
        job.updatedAt = new Date();

        if (pending > 0) {
            // Check how long we've been waiting for these downloads
            const oldestPending = downloadJobs
                .filter(
                    (j) => j.status === "pending" || j.status === "processing"
                )
                .sort(
                    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
                )[0];

            const waitTimeMs = oldestPending
                ? Date.now() - oldestPending.createdAt.getTime()
                : 0;
            const waitTimeMins = Math.round(waitTimeMs / 60000);

            // After 10 minutes of waiting, proceed anyway to avoid stuck jobs
            if (waitTimeMs < 600000) {
                // 10 minutes
                logger?.debug(
                    `   Still waiting for ${pending} downloads... (${waitTimeMins} min elapsed)`
                );
                jobLogger?.info(`Waiting for Soulseek downloads to complete...`);
                await saveImportJob(job);
                return;
            }

            logger?.debug(
                `   Timeout: ${pending} downloads still pending after ${waitTimeMins} minutes, proceeding anyway`
            );
            jobLogger?.warn(
                `Download timeout: ${pending} pending after ${waitTimeMins}m, proceeding with available tracks`
            );

            // Mark stale pending jobs as failed
            await prisma.downloadJob.updateMany({
                where: {
                    metadata: {
                        path: ['spotifyImportJobId'],
                        equals: importJobId,
                    },
                    status: { in: ["pending", "processing"] },
                },
                data: {
                    status: "failed",
                    error: "Timed out waiting for download",
                    completedAt: new Date(),
                },
            });
        }

        // All downloads finished (completed or failed)
        logger?.debug(`   All downloads finished! Triggering library scan...`);
        jobLogger?.info(
            `All ${total} download jobs finished (${completed} completed, ${failed} failed)`
        );

        // Trigger library scan to import the new files
        const { scanQueue } = await import("../workers/queues");
        const scanJob = await scanQueue.add("scan", {
            userId: job.userId,
            source: "spotify-import",
            spotifyImportJobId: importJobId,
        });

        jobLogger?.info(
            `Queued library scan (bullJobId=${scanJob.id ?? "unknown"})`
        );

        job.status = "scanning";
        job.progress = 75;
        job.updatedAt = new Date();
        await saveImportJob(job);
    }

    /**
     * Build playlist after library scan completes (called by scan worker)
     */
    async buildPlaylistAfterScan(importJobId: string): Promise<void> {
        logger?.debug(
            `\n[Spotify Import] Building playlist for job ${importJobId}...`
        );

        const job = await getImportJob(importJobId);
        if (!job) {
            logger?.debug(`   Job not found`);
            jobLoggers.delete(importJobId);
            return;
        }

        await this.buildPlaylist(job);
    }

    /**
     * Internal: Build the playlist with matched tracks
     */
    private async buildPlaylist(job: ImportJob): Promise<void> {
        const logger = jobLoggers.get(job.id);

        // A playlist is created outright rather than updated, so a second build
        // would produce a duplicate. Several things can ask for one — the scan
        // that finished, a user finishing the import by hand — and only the
        // first should win.
        if (job.createdPlaylistId) {
            logger?.debug(
                `[Spotify Import] Job ${job.id} already built playlist ${job.createdPlaylistId}; skipping`
            );
            return;
        }

        job.status = "creating_playlist";
        job.progress = 90;
        job.updatedAt = new Date();
        await saveImportJob(job);

        logger?.logPlaylistCreationStart();
        logger?.logTrackMatchingStart();

        // Match all pending tracks against the library
        const matchedTrackIds: string[] = [];
        // Which pending tracks found a home, by index. Recorded as we go, since
        // re-deriving it afterwards from the matched ids cannot be done reliably.
        const matchedPendingIndexes = new Set<number>();
        let trackIndex = 0;

        const jellyfinIndex = await this.loadJellyfinIndexIfSource(
            "[Import]"
        );

        for (const pendingTrack of job.pendingTracks) {
            trackIndex++;
            const pendingIndex = trackIndex - 1;

            // FAST PATH: If already matched in preview, use that ID directly
            // This ensures tracks found during preview are included in the final playlist
            if (pendingTrack.preMatchedTrackId) {
                // Jellyfin ids carry no Prisma row to verify against; they are
                // resolved against Jellyfin when the playlist is read.
                const preMatchedId = pendingTrack.preMatchedTrackId.startsWith(
                    "jellyfin:"
                )
                    ? pendingTrack.preMatchedTrackId
                    : (
                          await prisma.track.findUnique({
                              where: { id: pendingTrack.preMatchedTrackId },
                              select: { id: true },
                          })
                      )?.id;

                if (preMatchedId) {
                    matchedTrackIds.push(preMatchedId);
                    matchedPendingIndexes.add(pendingIndex);
                    logger?.debug(
                        `   ✓ Pre-matched: "${pendingTrack.title}" -> track ${preMatchedId}`
                    );
                    logger?.logTrackMatch(
                        trackIndex,
                        job.tracksTotal,
                        pendingTrack.title,
                        pendingTrack.artist,
                        true,
                        preMatchedId
                    );
                    continue;
                }
            }

            // Jellyfin library: match through its index rather than the Prisma
            // tables, which hold no library content in this mode.
            if (jellyfinIndex) {
                const matched = this.lookupInJellyfin(
                    jellyfinIndex,
                    pendingTrack
                );

                if (matched) {
                    matchedTrackIds.push(matched.entry.jellyfinId);
                    matchedPendingIndexes.add(pendingIndex);
                    logger?.debug(
                        `   ✓ Matched in Jellyfin: "${pendingTrack.title}" -> ${matched.entry.jellyfinId}`
                    );
                } else {
                    logger?.debug(
                        `   ✗ No match in Jellyfin: "${pendingTrack.title}" by ${pendingTrack.artist}`
                    );
                }

                logger?.logTrackMatch(
                    trackIndex,
                    job.tracksTotal,
                    pendingTrack.title,
                    pendingTrack.artist,
                    !!matched,
                    matched?.entry.jellyfinId
                );
                continue;
            }

            const normalizedArtist = normalizeString(pendingTrack.artist);
            // Get first word for fuzzy artist matching (handles "Nick Cave & The Bad Seeds" -> "nick")
            const artistFirstWord = artistLookupFirstWord(pendingTrack.artist);
            // Strip suffix but keep punctuation for DB queries: "Ain't Gonna Rain Anymore - 2011 Remaster" -> "Ain't Gonna Rain Anymore"
            const strippedTitle = stripTrackSuffix(pendingTrack.title);
            // Also normalize apostrophes in the original title for searching
            const normalizedTitle = normalizeApostrophes(pendingTrack.title);
            // Fully normalized for similarity comparison: "aint gonna rain anymore"
            const cleanedTitle = normalizeTrackTitle(pendingTrack.title);

            logger?.log(
                `   Matching: "${pendingTrack.title}" by ${pendingTrack.artist}`
            );
            logger?.log(
                `   strippedTitle: "${strippedTitle}", artistFirstWord: "${artistFirstWord}"`
            );

            // Try multiple matching strategies
            let localTrack = null;

            // Strategy 1: Exact title match with fuzzy artist (contains first word)
            localTrack = await prisma.track.findFirst({
                where: {
                    title: {
                        equals: normalizedTitle,
                        mode: "insensitive",
                    },
                    album: {
                        artist: {
                            normalizedName: {
                                contains: artistFirstWord,
                                mode: "insensitive",
                            },
                        },
                    },
                },
            });

            // Strategy 2: Stripped title match (removes remaster suffix but keeps punctuation)
            // "Ain't Gonna Rain Anymore - 2011 Remaster" -> searches for "Ain't Gonna Rain Anymore"
            if (!localTrack && strippedTitle !== normalizedTitle) {
                logger?.log(
                    `   Strategy 2: Searching for stripped title "${strippedTitle}"`
                );
                localTrack = await prisma.track.findFirst({
                    where: {
                        title: {
                            equals: strippedTitle,
                            mode: "insensitive",
                        },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                });
            }

            // Strategy 3: Case-insensitive CONTAINS search on title (handles slight variations)
            // e.g., database has "Ain't" but Spotify has "Ain't" (different apostrophe after normalization still differs)
            if (!localTrack && strippedTitle.length >= 5) {
                // Search for tracks where title contains the first few words
                const searchTerm = strippedTitle
                    .split(" ")
                    .slice(0, 4)
                    .join(" ");
                logger?.log(
                    `   Strategy 3: Contains search for "${searchTerm}"`
                );
                const candidates = await prisma.track.findMany({
                    where: {
                        title: {
                            contains: searchTerm,
                            mode: "insensitive",
                        },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    take: 10,
                });

                // Find best match using similarity OR containment
                for (const candidate of candidates) {
                    const candidateNormalized = normalizeTrackTitle(
                        candidate.title
                    );
                    const sim = stringSimilarity(
                        cleanedTitle,
                        candidateNormalized
                    );

                    // Direct similarity match
                    if (sim >= 80) {
                        localTrack = candidate;
                        logger?.log(
                            `      Found via contains+similarity (${sim.toFixed(
                                0
                            )}%)`
                        );
                        break;
                    }

                    // Containment match: "Sordid Affair" should match "Sordid Affair (Feat. Ryan James)"
                    // Check if one title contains the other (normalized)
                    const spotifyNorm = cleanedTitle.toLowerCase();
                    const libraryNorm = candidateNormalized.toLowerCase();
                    if (
                        libraryNorm.startsWith(spotifyNorm) ||
                        spotifyNorm.startsWith(libraryNorm)
                    ) {
                        localTrack = candidate;
                        logger?.log(
                            `      Found via containment match: "${cleanedTitle}" in "${candidateNormalized}"`
                        );
                        break;
                    }
                }
            }

            // Strategy 3.5: Same as preview - fuzzy match on artist NAME using similarity
            // This catches cases where normalizedName differs from what we expect
            if (!localTrack) {
                logger?.log(`   Strategy 3.5: Fuzzy artist+title matching`);
                const candidates = await prisma.track.findMany({
                    where: {
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    include: { album: { include: { artist: true } } },
                    take: 50,
                });

                // Use same matching as preview: compare cleaned titles
                for (const candidate of candidates) {
                    const titleSim = stringSimilarity(
                        cleanedTitle,
                        normalizeTrackTitle(candidate.title)
                    );
                    const artistSim = stringSimilarity(
                        pendingTrack.artist,
                        candidate.album.artist.name
                    );
                    const score = titleSim * 0.6 + artistSim * 0.4;

                    if (score >= 70) {
                        localTrack = candidate;
                        logger?.debug(
                            `      (preview-style match: ${score.toFixed(0)}%)`
                        );
                        break;
                    }
                }
            }

            // Strategy 4: StartsWith match with stripped title (for slight title variations)
            if (!localTrack && strippedTitle.length > 10) {
                logger?.log(`   Strategy 4: StartsWith search`);
                localTrack = await prisma.track.findFirst({
                    where: {
                        title: {
                            startsWith: strippedTitle.substring(
                                0,
                                Math.min(20, strippedTitle.length)
                            ),
                            mode: "insensitive",
                        },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                });

                // Verify match
                if (localTrack) {
                    const dbTitleNormalized = normalizeTrackTitle(
                        localTrack.title
                    );
                    if (
                        stringSimilarity(cleanedTitle, dbTitleNormalized) < 70
                    ) {
                        localTrack = null;
                    } else {
                        logger?.log(`      Found via startsWith`);
                    }
                }
            }

            // Strategy 5: Very fuzzy - search and score by similarity (last resort)
            if (!localTrack) {
                logger?.log(`   Strategy 5: Fuzzy search (last resort)`);
                // Get first few words for search
                const searchWords = strippedTitle
                    .split(" ")
                    .slice(0, 3)
                    .join(" ");
                if (searchWords.length >= 4) {
                    const candidates = await prisma.track.findMany({
                        where: {
                            title: {
                                contains: searchWords.split(" ")[0], // Just first word
                                mode: "insensitive",
                            },
                            album: {
                                artist: {
                                    normalizedName: {
                                        contains: artistFirstWord,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                        include: { album: { include: { artist: true } } },
                        take: 20,
                    });

                    // Find best match by similarity
                    let bestMatch = null;
                    let bestScore = 0;
                    for (const candidate of candidates) {
                        const titleScore = stringSimilarity(
                            cleanedTitle,
                            normalizeTrackTitle(candidate.title)
                        );
                        const artistScore = stringSimilarity(
                            normalizedArtist,
                            normalizeString(candidate.album.artist.name)
                        );
                        const combinedScore =
                            titleScore * 0.7 + artistScore * 0.3;

                        if (combinedScore > bestScore && combinedScore >= 65) {
                            bestScore = combinedScore;
                            bestMatch = candidate;
                        }
                    }

                    if (bestMatch) {
                        localTrack = bestMatch;
                        logger?.debug(
                            `      (fuzzy match: score ${bestScore.toFixed(
                                0
                            )}% with "${bestMatch.title}" by ${
                                bestMatch.album.artist.name
                            })`
                        );
                    }
                }
            }

            // Strategy 6: Title-only search (ignores artist entirely)
            // This handles cases where file has wrong artist metadata (e.g., "Various Artists" compilations)
            // Only used when title is distinctive enough (>10 chars) and no match found yet
            if (!localTrack && cleanedTitle.length >= 10) {
                logger?.log(
                    `   Strategy 6: Title-only search (fallback for wrong artist metadata)`
                );

                // Search for tracks with very similar title, ignore artist completely
                const titleSearchTerm = strippedTitle
                    .split(" ")
                    .slice(0, 4)
                    .join(" ");
                const candidates = await prisma.track.findMany({
                    where: {
                        title: {
                            contains: titleSearchTerm,
                            mode: "insensitive",
                        },
                    },
                    include: { album: { include: { artist: true } } },
                    take: 50,
                });

                // Find a high-confidence title match (require 85%+ similarity on title alone)
                let bestTitleMatch = null;
                let bestTitleScore = 0;

                for (const candidate of candidates) {
                    const titleScore = stringSimilarity(
                        cleanedTitle,
                        normalizeTrackTitle(candidate.title)
                    );

                    // Require very high title match since we're ignoring artist
                    if (titleScore > bestTitleScore && titleScore >= 85) {
                        bestTitleScore = titleScore;
                        bestTitleMatch = candidate;
                    }
                }

                if (bestTitleMatch) {
                    localTrack = bestTitleMatch;
                    logger?.log(
                        `      Found via title-only match (${bestTitleScore.toFixed(
                            0
                        )}%): "${bestTitleMatch.title}" by ${
                            bestTitleMatch.album.artist.name
                        }`
                    );
                    logger?.debug(
                        `      (title-only match: ${bestTitleScore.toFixed(
                            0
                        )}% - note: artist metadata mismatch, wanted "${
                            pendingTrack.artist
                        }" got "${bestTitleMatch.album.artist.name}")`
                    );
                }
            }

            if (localTrack) {
                matchedTrackIds.push(localTrack.id);
                matchedPendingIndexes.add(pendingIndex);
                logger?.debug(
                    `   ✓ Matched: "${pendingTrack.title}" -> track ${localTrack.id}`
                );
                logger?.logTrackMatch(
                    trackIndex,
                    job.tracksTotal,
                    pendingTrack.title,
                    pendingTrack.artist,
                    true,
                    localTrack.id
                );
            } else {
                // Debug: Check if artist exists at all
                const artistExists = await prisma.artist.findFirst({
                    where: {
                        normalizedName: {
                            contains: artistFirstWord,
                            mode: "insensitive",
                        },
                    },
                    select: { name: true, normalizedName: true },
                });
                if (artistExists) {
                    logger?.debug(
                        `   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist "${artistExists.name}" exists but track not found)`
                    );
                } else {
                    logger?.debug(
                        `   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist not in library)`
                    );
                }
                logger?.logTrackMatch(
                    trackIndex,
                    job.tracksTotal,
                    pendingTrack.title,
                    pendingTrack.artist,
                    false
                );
            }
        }

        const uniqueTrackIds = Array.from(new Set(matchedTrackIds));
        if (uniqueTrackIds.length < matchedTrackIds.length) {
            const removed = matchedTrackIds.length - uniqueTrackIds.length;
            logger?.debug(
                `   Removed ${removed} duplicate track references before playlist creation`
            );
            logger?.info(
                `Removed ${removed} duplicate track references before playlist creation`
            );
        }

        logger?.debug(
            `   Matched ${uniqueTrackIds.length}/${job.tracksTotal} tracks`
        );
        logger?.info(
            `Matched tracks after scan: ${uniqueTrackIds.length}/${job.tracksTotal}`
        );
        // Create the playlist with Spotify metadata
        const playlist = await prisma.playlist.create({
            data: {
                userId: job.userId,
                name: job.playlistName,
                isPublic: false,
                spotifyPlaylistId: job.spotifyPlaylistId,
                items:
                    uniqueTrackIds.length > 0
                        ? {
                              create: uniqueTrackIds.map((trackId, index) => ({
                                  trackId,
                                  sort: index,
                              })),
                          }
                        : undefined,
            },
        });

        // Save unmatched tracks as pending tracks for later auto-matching.
        // The matching loop above already recorded exactly which ones landed,
        // so use that rather than trying to reverse-engineer it from the ids.
        const pendingTracksToSave = job.pendingTracks
            .map((track, index) => ({ ...track, originalIndex: index }))
            .filter((track) => !matchedPendingIndexes.has(track.originalIndex));

        if (pendingTracksToSave.length > 0) {
            logger?.debug(
                `   Saving ${pendingTracksToSave.length} pending tracks for future auto-matching`
            );
            logger?.debug(
                `   Fetching Deezer preview URLs for pending tracks...`
            );
            logger?.info(
                `Saving pending tracks: ${pendingTracksToSave.length}`
            );

            // Fetch Deezer previews with concurrency limit to avoid overwhelming API
            const DEEZER_PREVIEW_CONCURRENCY = 5;
            const previewQueue = new PQueue({ concurrency: DEEZER_PREVIEW_CONCURRENCY });

            const pendingTracksWithPreviews = await Promise.all(
                pendingTracksToSave.map((track) =>
                    previewQueue.add(async () => {
                        let deezerPreviewUrl: string | null = null;
                        try {
                            deezerPreviewUrl = await deezerService.getTrackPreview(
                                track.artist,
                                track.title
                            );
                        } catch (e) {
                            // Preview not critical, continue without it
                        }
                        return {
                            ...track,
                            deezerPreviewUrl,
                        };
                    })
                )
            );

            const previewsFound = pendingTracksWithPreviews.filter(
                (t) => t.deezerPreviewUrl
            ).length;
            logger?.debug(
                `   Found ${previewsFound}/${pendingTracksToSave.length} Deezer preview URLs`
            );
            logger?.info(
                `Pending previews found: ${previewsFound}/${pendingTracksToSave.length}`
            );

            await prisma.playlistPendingTrack.createMany({
                data: pendingTracksWithPreviews.map((track) => ({
                    playlistId: playlist.id,
                    spotifyArtist: track.artist,
                    spotifyTitle: track.title,
                    spotifyAlbum: track.album,
                    albumMbid: track.albumMbid,
                    artistMbid: track.artistMbid,
                    deezerPreviewUrl: track.deezerPreviewUrl,
                    sort: track.originalIndex,
                })),
                skipDuplicates: true,
            });
        }

        // Put it in Jellyfin too, so the import is visible from every other
        // Jellyfin client and not just this one.
        await syncPlaylistToJellyfin(playlist.id);

        job.createdPlaylistId = playlist.id;
        job.tracksMatched = uniqueTrackIds.length;
        job.status = "completed";
        job.progress = 100;
        job.updatedAt = new Date();
        await saveImportJob(job);

        logger?.debug(`[Spotify Import] Job ${job.id} completed:`);
        logger?.debug(`   Playlist created: ${playlist.id}`);
        logger?.debug(
            `   Tracks matched: ${matchedTrackIds.length}/${job.tracksTotal}`
        );

        logger?.logPlaylistCreated(
            playlist.id,
            matchedTrackIds.length,
            job.tracksTotal
        );
        logger?.logJobComplete(
            matchedTrackIds.length,
            job.tracksTotal,
            playlist.id
        );

        // Send notification about import completion
        try {
            await notificationService.notifyImportComplete(
                job.userId,
                job.playlistName,
                playlist.id,
                matchedTrackIds.length,
                job.tracksTotal
            );
        } catch (notifError) {
            logger?.error(`Failed to send import notification: ${notifError}`);
        }

        // Clean up job logger to prevent memory leak
        jobLoggers.delete(job.id);
    }

    /**
     * Re-match pending tracks and add newly downloaded ones to the playlist
     */
    async refreshJobMatches(
        jobId: string
    ): Promise<{ added: number; total: number }> {
        const logger = jobLoggers.get(jobId);
        const job = await getImportJob(jobId);
        if (!job) {
            throw new Error("Import job not found");
        }
        // Before the playlist exists there is nothing to add to, but this is
        // exactly when a re-check is most useful: a download that failed may
        // have arrived by other means, and the user wants to know before
        // deciding to finish without it.
        if (!job.createdPlaylistId) {
            return this.resolvePendingMatches(job);
        }

        let added = 0;

        // Get existing tracks in playlist
        const existingItems = await prisma.playlistItem.findMany({
            where: { playlistId: job.createdPlaylistId },
            select: { trackId: true },
        });
        const existingTrackIds = new Set(
            existingItems.map((item) => item.trackId)
        );

        // Get next position
        const maxPosition = existingItems.length;
        let nextPosition = maxPosition;

        // A manual re-check is usually asked for right after a download, so top
        // up Jellyfin's index first — otherwise the new file is not in the
        // metadata table yet and the re-check reports nothing found.
        await this.refreshJellyfinBeforeRematch(logger);

        const jellyfinIndex = await this.loadJellyfinIndexIfSource(
            "[Import refresh]"
        );

        // Try to match each pending track
        for (const pendingTrack of job.pendingTracks) {
            const normalizedArtist = artistLookupKey(pendingTrack.artist);

            const jellyfinMatch = jellyfinIndex
                ? this.lookupInJellyfin(jellyfinIndex, pendingTrack)
                : null;

            const localTrack = jellyfinIndex
                ? jellyfinMatch && { id: jellyfinMatch.entry.jellyfinId }
                : // Track model doesn't have normalizedTitle - use case-insensitive title matching
                  await prisma.track.findFirst({
                      where: {
                          title: {
                              equals: pendingTrack.title,
                              mode: "insensitive",
                          },
                          album: {
                              artist: {
                                  normalizedName: normalizedArtist,
                              },
                          },
                      },
                  });

            if (localTrack && !existingTrackIds.has(localTrack.id)) {
                // Add to playlist
                await prisma.playlistItem.create({
                    data: {
                        playlistId: job.createdPlaylistId,
                        trackId: localTrack.id,
                        sort: nextPosition++,
                    },
                });
                existingTrackIds.add(localTrack.id);
                added++;
            }
        }

        if (added > 0) {
            await syncPlaylistToJellyfin(job.createdPlaylistId);
        }

        job.tracksMatched += added;
        job.updatedAt = new Date();
        await saveImportJob(job);

        logger?.debug(
            `[Spotify Import] Refresh job ${jobId}: added ${added} newly downloaded tracks`
        );
        logger?.info(
            `Refresh: added ${added} newly downloaded track(s), totalMatchedNow=${job.tracksMatched}`
        );

        return { added, total: job.tracksMatched };
    }

    /**
     * Re-match the tracks of an import that hasn't built its playlist yet, and
     * remember anything that has since turned up.
     *
     * Recording the match on the job is what makes it stick: the track shows as
     * in the library from then on, and the playlist build will use it.
     */
    private async resolvePendingMatches(
        job: ImportJob
    ): Promise<{ added: number; total: number }> {
        const logger = jobLoggers.get(job.id);

        await this.refreshJellyfinBeforeRematch(logger);
        const jellyfinIndex = await this.loadJellyfinIndexIfSource(
            "[Import re-check]"
        );

        let added = 0;
        for (const pendingTrack of job.pendingTracks) {
            if (pendingTrack.preMatchedTrackId) continue;

            const matchedId = jellyfinIndex
                ? this.lookupInJellyfin(jellyfinIndex, pendingTrack)?.entry
                      .jellyfinId
                : (
                      await prisma.track.findFirst({
                          where: {
                              title: {
                                  equals: pendingTrack.title,
                                  mode: "insensitive",
                              },
                              album: {
                                  artist: {
                                      normalizedName: artistLookupKey(
                                          pendingTrack.artist
                                      ),
                                  },
                              },
                          },
                          select: { id: true },
                      })
                  )?.id;

            if (matchedId) {
                pendingTrack.preMatchedTrackId = matchedId;
                added++;
            }
        }

        const total = job.pendingTracks.filter(
            (t) => t.preMatchedTrackId
        ).length;

        if (added > 0) {
            job.updatedAt = new Date();
            await saveImportJob(job);
        }

        logger?.info(
            `Re-check: ${added} newly available, ${total}/${job.pendingTracks.length} now in the library`
        );

        return { added, total };
    }

    /**
     * Build the playlist now with whatever is available, abandoning anything
     * still outstanding.
     *
     * An import waits on every download it queued, so one album that can't be
     * found holds back a playlist whose other songs are all sitting in the
     * library. This is the way out of that, and the way to accept a download
     * that has genuinely failed.
     */
    async finishNow(jobId: string): Promise<{
        skipped: number;
        matched: number;
        playlistId: string | null;
        alreadyFinished: boolean;
    }> {
        const job = await getImportJob(jobId);
        if (!job) {
            throw new Error("Import job not found");
        }

        // A playlist is created, never updated in place, so building a second
        // time would duplicate it.
        if (job.createdPlaylistId) {
            return {
                skipped: 0,
                matched: job.tracksMatched,
                playlistId: job.createdPlaylistId,
                alreadyFinished: true,
            };
        }
        if (job.status === "creating_playlist") {
            throw new Error("This import is already building its playlist");
        }
        if (job.status === "cancelled" || job.status === "failed") {
            throw new Error(`This import was ${job.status}`);
        }

        const skipped = await prisma.downloadJob.updateMany({
            where: {
                status: { in: ["pending", "processing"] },
                metadata: {
                    path: ["spotifyImportJobId"],
                    equals: jobId,
                },
            },
            data: {
                status: "failed",
                error: "Skipped by user",
                completedAt: new Date(),
            },
        });

        // Count anything that did land, including a download that finished
        // moments ago and hasn't reached the metadata index yet.
        await this.refreshJellyfinBeforeRematch(jobLoggers.get(jobId));
        await this.buildPlaylist(job);

        return {
            skipped: skipped.count,
            matched: job.tracksMatched,
            playlistId: job.createdPlaylistId ?? null,
            alreadyFinished: false,
        };
    }

    /**
     * Get import job status (public method for routes)
     */
    async getJob(jobId: string): Promise<ImportJob | null> {
        return await getImportJob(jobId);
    }

    /**
     * Per-track state for one import, so a stalled track can be identified
     * rather than hidden behind an overall percentage.
     */
    async getJobTracks(jobId: string): Promise<{
        tracks: ImportTrackRow[];
        summary: ImportTrackSummary;
        skippableDownloadIds: string[];
    } | null> {
        const job = await getImportJob(jobId);
        if (!job) return null;

        const downloadJobs = await prisma.downloadJob.findMany({
            where: {
                metadata: {
                    path: ["spotifyImportJobId"],
                    equals: jobId,
                },
            },
            select: {
                id: true,
                status: true,
                subject: true,
                targetMbid: true,
                error: true,
                metadata: true,
            },
        });

        const jobFinished = !ACTIVE_IMPORT_STATUSES.includes(
            job.status as (typeof ACTIVE_IMPORT_STATUSES)[number]
        );

        // Leftovers only exist once a playlist has been built, and they are the
        // record of what the import ultimately failed to place.
        let unmatchedKeys: Set<string> | undefined;
        if (jobFinished && job.createdPlaylistId) {
            const leftovers = await prisma.playlistPendingTrack.findMany({
                where: { playlistId: job.createdPlaylistId },
                select: { spotifyArtist: true, spotifyTitle: true },
            });
            unmatchedKeys = new Set(
                leftovers.map((t) =>
                    unmatchedTrackKey(t.spotifyArtist, t.spotifyTitle)
                )
            );
        }

        const { tracks, summary } = deriveImportTrackRows({
            pendingTracks: job.pendingTracks,
            downloadJobs,
            unmatchedKeys,
            jobFinished,
        });

        return {
            tracks,
            summary,
            skippableDownloadIds: inFlightDownloadIds(downloadJobs),
        };
    }

    /**
     * Abandon downloads an import is waiting on and let it move to the next
     * phase with whatever did arrive.
     *
     * Without this, a download that never reports back leaves the import parked
     * until the ten-minute staleness check happens to run again — and if nothing
     * triggers that check, indefinitely.
     */
    async skipDownloads(
        jobId: string,
        downloadJobIds: string[]
    ): Promise<{ skipped: number }> {
        if (downloadJobIds.length === 0) return { skipped: 0 };

        const result = await prisma.downloadJob.updateMany({
            where: {
                id: { in: downloadJobIds },
                status: { in: ["pending", "processing"] },
                metadata: {
                    path: ["spotifyImportJobId"],
                    equals: jobId,
                },
            },
            data: {
                status: "failed",
                error: "Skipped by user",
                completedAt: new Date(),
            },
        });

        // Re-evaluate now rather than waiting for the next external trigger,
        // which is the whole point of skipping. Only when something actually
        // changed, so a no-op call can't queue a second library scan for an
        // import that has already moved on.
        if (result.count > 0) {
            await this.checkImportCompletion(jobId);
        }

        return { skipped: result.count };
    }

    /**
     * Get all jobs for a user
     */
    async getUserJobs(userId: string): Promise<ImportJob[]> {
        // Get from database to include jobs across restarts
        const dbJobs = await prisma.spotifyImportJob.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });

        return dbJobs
            .map((dbJob) => ({
                id: dbJob.id,
                userId: dbJob.userId,
                spotifyPlaylistId: dbJob.spotifyPlaylistId,
                playlistName: dbJob.playlistName,
                status: dbJob.status as ImportJob["status"],
                progress: dbJob.progress,
                albumsTotal: dbJob.albumsTotal,
                albumsCompleted: dbJob.albumsCompleted,
                tracksMatched: dbJob.tracksMatched,
                tracksTotal: dbJob.tracksTotal,
                tracksDownloadable: dbJob.tracksDownloadable,
                createdPlaylistId: dbJob.createdPlaylistId,
                error: dbJob.error,
                createdAt: dbJob.createdAt,
                updatedAt: dbJob.updatedAt,
                pendingTracks: (dbJob.pendingTracks as any) || [],
            }))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    /**
     * In-flight imports for a user. Kept deliberately lightweight because the
     * client polls this to keep an import visible after a refresh or a
     * navigation away from the import page.
     */
    async getActiveJobs(userId: string): Promise<ActiveImportJob[]> {
        const cutoff = new Date(Date.now() - ACTIVE_IMPORT_MAX_IDLE_MS);

        const dbJobs = await prisma.spotifyImportJob.findMany({
            where: {
                userId,
                status: { in: [...ACTIVE_IMPORT_STATUSES] },
                updatedAt: { gte: cutoff },
            },
            orderBy: { createdAt: "desc" },
            select: IMPORT_JOB_SUMMARY_SELECT,
        });

        return dbJobs.map((job) => ({
            ...job,
            status: job.status as ImportJob["status"],
        }));
    }

    /**
     * A user's most recent imports, running and finished alike, newest first.
     *
     * Shares the lightweight shape with getActiveJobs so the UI can show
     * progress and history from one list, and can be polled while something is
     * still running.
     */
    async getRecentJobs(
        userId: string,
        limit = 20
    ): Promise<ActiveImportJob[]> {
        const dbJobs = await prisma.spotifyImportJob.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: Math.min(Math.max(limit, 1), 100),
            select: IMPORT_JOB_SUMMARY_SELECT,
        });

        return dbJobs.map((job) => ({
            ...job,
            status: job.status as ImportJob["status"],
        }));
    }

    /**
     * Cancel an import job without creating a playlist.
     * All pending downloads are marked as failed and the job is marked as cancelled.
     */
    async cancelJob(jobId: string): Promise<{
        playlistCreated: boolean;
        playlistId: string | null;
        tracksMatched: number;
    }> {
        const job = await getImportJob(jobId);
        if (!job) {
            throw new Error("Import job not found");
        }

        const logger = jobLoggers.get(jobId);
        logger?.debug(`[Spotify Import] Cancelling job ${jobId}...`);
        logger?.info(`Job cancelled by user`);

        // If already completed, cancelled, or failed, nothing to do
        if (
            job.status === "completed" ||
            job.status === "failed" ||
            job.status === "cancelled"
        ) {
            return {
                playlistCreated: !!job.createdPlaylistId,
                playlistId: job.createdPlaylistId || null,
                tracksMatched: job.tracksMatched,
            };
        }

        // Mark any pending download jobs as cancelled
        await prisma.downloadJob.updateMany({
            where: {
                metadata: {
                    path: ['spotifyImportJobId'],
                    equals: jobId,
                },
                status: { in: ["pending", "processing"] },
            },
            data: {
                status: "failed",
                error: "Import cancelled by user",
                completedAt: new Date(),
            },
        });

        // Mark job as cancelled - do NOT create a playlist
        job.status = "cancelled";
        job.updatedAt = new Date();
        await saveImportJob(job);
        logger?.info(`Import cancelled by user - no playlist created`);

        return {
            playlistCreated: false,
            playlistId: null,
            tracksMatched: 0,
        };
    }

    /**
     * Reconcile pending tracks for ALL playlists after a library scan
     * This checks if any previously unmatched tracks now have matches in the library
     * and automatically adds them to their playlists
     */
    async reconcilePendingTracks(): Promise<{
        playlistsUpdated: number;
        tracksAdded: number;
    }> {
        logger?.debug(
            `\n[Spotify Import] Reconciling pending tracks across all playlists...`
        );

        // Get all pending tracks grouped by playlist
        const allPendingTracks = await prisma.playlistPendingTrack.findMany({
            include: {
                playlist: {
                    select: {
                        id: true,
                        name: true,
                        userId: true,
                    },
                },
            },
            orderBy: [{ playlistId: "asc" }, { sort: "asc" }],
        });

        if (allPendingTracks.length === 0) {
            logger?.debug(`   No pending tracks to reconcile`);
            return { playlistsUpdated: 0, tracksAdded: 0 };
        }

        logger?.debug(
            `   Found ${allPendingTracks.length} pending tracks across playlists`
        );

        let totalTracksAdded = 0;
        const playlistsWithAdditions = new Set<string>();
        const matchedPendingTrackIds: string[] = [];

        // Group by playlist for efficient processing
        const tracksByPlaylist = new Map<string, typeof allPendingTracks>();
        for (const pt of allPendingTracks) {
            const existing = tracksByPlaylist.get(pt.playlistId) || [];
            existing.push(pt);
            tracksByPlaylist.set(pt.playlistId, existing);
        }

        for (const [playlistId, pendingTracks] of tracksByPlaylist) {
            // Get current max sort position in playlist
            const maxSortResult = await prisma.playlistItem.aggregate({
                where: { playlistId },
                _max: { sort: true },
            });
            let nextSort = (maxSortResult._max.sort ?? -1) + 1;

            // Get existing track IDs in playlist to avoid duplicates
            const existingItems = await prisma.playlistItem.findMany({
                where: { playlistId },
                select: { trackId: true },
            });
            const existingTrackIds = new Set(
                existingItems.map((item) => item.trackId)
            );

            for (const pendingTrack of pendingTracks) {
                const artistFirstWord = artistLookupFirstWord(
                    pendingTrack.spotifyArtist
                );
                const strippedTitle = stripTrackSuffix(
                    pendingTrack.spotifyTitle
                );
                const cleanedTitle = normalizeTrackTitle(strippedTitle);

                logger?.debug(
                    `   Trying to match: "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`
                );
                logger?.debug(
                    `      strippedTitle: "${strippedTitle}", artistFirstWord: "${artistFirstWord}"`
                );

                // Debug: Check what tracks exist for this artist
                const artistTracks = await prisma.track.findMany({
                    where: {
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    select: {
                        title: true,
                        album: {
                            select: {
                                artist: {
                                    select: {
                                        name: true,
                                        normalizedName: true,
                                    },
                                },
                            },
                        },
                    },
                    take: 5,
                });
                if (artistTracks.length > 0) {
                    logger?.debug(
                        `      DEBUG: Found ${artistTracks.length}+ tracks for artist containing "${artistFirstWord}"`
                    );
                    artistTracks
                        .slice(0, 3)
                        .forEach((t) =>
                            logger?.debug(
                                `         - "${t.title}" (artist: ${t.album.artist.name}, normalized: ${t.album.artist.normalizedName})`
                            )
                        );
                } else {
                    logger?.debug(
                        `      DEBUG: NO tracks found for artist containing "${artistFirstWord}"`
                    );
                }

                // Try to find a matching track (using same strategies as buildPlaylist)
                // Strategy 1: Stripped title + fuzzy artist (contains first word)
                let localTrack = await prisma.track.findFirst({
                    where: {
                        title: { equals: strippedTitle, mode: "insensitive" },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    select: { id: true, title: true },
                });

                logger?.debug(
                    `      Strategy 1 result: ${
                        localTrack ? "FOUND" : "not found"
                    }`
                );

                // Strategy 2: Contains search on first few words + similarity
                if (!localTrack && strippedTitle.length >= 5) {
                    const searchTerm = strippedTitle
                        .split(" ")
                        .slice(0, 4)
                        .join(" ");
                    logger?.debug(
                        `      Strategy 2: Contains search for "${searchTerm}"`
                    );
                    const candidates = await prisma.track.findMany({
                        where: {
                            title: {
                                contains: searchTerm,
                                mode: "insensitive",
                            },
                            album: {
                                artist: {
                                    normalizedName: {
                                        contains: artistFirstWord,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                        include: { album: { include: { artist: true } } },
                        take: 10,
                    });

                    logger?.debug(
                        `      Strategy 2: Found ${candidates.length} candidates`
                    );
                    for (const candidate of candidates) {
                        const candidateNormalized = normalizeTrackTitle(
                            candidate.title
                        );
                        const sim = stringSimilarity(
                            cleanedTitle,
                            candidateNormalized
                        );
                        logger?.debug(
                            `         "${candidate.title}" by ${
                                candidate.album.artist.name
                            }: ${sim.toFixed(0)}%`
                        );

                        // Direct similarity match
                        if (sim >= 80) {
                            localTrack = {
                                id: candidate.id,
                                title: candidate.title,
                            };
                            break;
                        }

                        // Containment match: "Sordid Affair" should match "Sordid Affair (Feat. Ryan James)"
                        const spotifyNorm = cleanedTitle.toLowerCase();
                        const libraryNorm = candidateNormalized.toLowerCase();
                        if (
                            libraryNorm.startsWith(spotifyNorm) ||
                            spotifyNorm.startsWith(libraryNorm)
                        ) {
                            logger?.debug(
                                `         Found via containment: "${cleanedTitle}" starts "${candidateNormalized}"`
                            );
                            localTrack = {
                                id: candidate.id,
                                title: candidate.title,
                            };
                            break;
                        }
                    }
                }

                if (!localTrack)
                    logger?.debug(`      Strategy 2 result: not found`);

                // Strategy 3: Fuzzy match on title + artist similarity
                if (!localTrack) {
                    const firstWord = strippedTitle.split(" ")[0];
                    logger?.debug(
                        `      Strategy 3: Fuzzy search for title containing "${firstWord}" and artist containing "${artistFirstWord}"`
                    );
                    const candidates = await prisma.track.findMany({
                        where: {
                            title: { contains: firstWord, mode: "insensitive" },
                            album: {
                                artist: {
                                    normalizedName: {
                                        contains: artistFirstWord,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                        include: { album: { include: { artist: true } } },
                        take: 20,
                    });

                    logger?.debug(
                        `      Strategy 3: Found ${candidates.length} candidates`
                    );
                    for (const candidate of candidates) {
                        const titleScore = stringSimilarity(
                            cleanedTitle,
                            normalizeTrackTitle(candidate.title)
                        );
                        const artistScore = stringSimilarity(
                            pendingTrack.spotifyArtist,
                            candidate.album.artist.name
                        );
                        const combinedScore =
                            titleScore * 0.6 + artistScore * 0.4;
                        logger?.debug(
                            `         "${candidate.title}" by ${
                                candidate.album.artist.name
                            }: title=${titleScore.toFixed(
                                0
                            )}%, artist=${artistScore.toFixed(
                                0
                            )}%, combined=${combinedScore.toFixed(0)}%`
                        );

                        if (combinedScore >= 70) {
                            localTrack = {
                                id: candidate.id,
                                title: candidate.title,
                            };
                            break;
                        }
                    }
                }

                // Strategy 4: Title-only match with artist scoring (for compilations / Various Artists)
                if (!localTrack) {
                    logger?.debug(
                        `      Strategy 4: Title-only match for "${strippedTitle}" (compilation fallback)`
                    );
                    const candidates = await prisma.track.findMany({
                        where: {
                            title: { equals: strippedTitle, mode: "insensitive" },
                        },
                        include: { album: { include: { artist: true } } },
                        take: 10,
                    });

                    if (candidates.length > 0) {
                        // Score by artist name similarity, pick best match
                        const scored = candidates.map((c) => ({
                            candidate: c,
                            score: stringSimilarity(
                                pendingTrack.spotifyArtist,
                                c.album.artist.name
                            ),
                        }));
                        scored.sort((a, b) => b.score - a.score);

                        const best = scored[0];
                        logger?.debug(
                            `      Strategy 4: Best match "${best.candidate.title}" by ${best.candidate.album.artist.name} (artist score: ${best.score.toFixed(0)}%)`
                        );

                        // Accept if artist similarity is reasonable (>= 40%) or if there's only one candidate
                        if (best.score >= 40 || candidates.length === 1) {
                            localTrack = {
                                id: best.candidate.id,
                                title: best.candidate.title,
                            };
                        }
                    }
                }

                if (localTrack && !existingTrackIds.has(localTrack.id)) {
                    // Add to playlist
                    await prisma.playlistItem.create({
                        data: {
                            playlistId,
                            trackId: localTrack.id,
                            sort: nextSort++,
                        },
                    });

                    existingTrackIds.add(localTrack.id);
                    matchedPendingTrackIds.push(pendingTrack.id);
                    totalTracksAdded++;
                    playlistsWithAdditions.add(playlistId);

                    logger?.debug(
                        `   ✓ Matched: "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`
                    );
                }
            }
        }

        // Delete the matched pending tracks
        if (matchedPendingTrackIds.length > 0) {
            await prisma.playlistPendingTrack.deleteMany({
                where: { id: { in: matchedPendingTrackIds } },
            });
        }

        // A song that only turned up now still belongs in the Jellyfin copy.
        for (const playlistId of playlistsWithAdditions) {
            await syncPlaylistToJellyfin(playlistId);
        }

        // Send notifications for each playlist that was updated
        if (playlistsWithAdditions.size > 0) {
            const { notificationService } = await import(
                "./notificationService"
            );

            for (const playlistId of playlistsWithAdditions) {
                const playlist = await prisma.playlist.findUnique({
                    where: { id: playlistId },
                    select: { id: true, name: true, userId: true },
                });

                if (playlist) {
                    const tracksAddedToPlaylist = matchedPendingTrackIds.filter(
                        (id) =>
                            allPendingTracks.find(
                                (pt) =>
                                    pt.id === id && pt.playlistId === playlistId
                            )
                    ).length;

                    await notificationService.create({
                        userId: playlist.userId,
                        type: "playlist_ready",
                        title: "Playlist Updated",
                        message: `${tracksAddedToPlaylist} new track${
                            tracksAddedToPlaylist !== 1 ? "s" : ""
                        } added to "${playlist.name}"`,
                        metadata: {
                            playlistId: playlist.id,
                            tracksAdded: tracksAddedToPlaylist,
                        },
                    });
                }
            }
        }

        logger?.debug(
            `   Reconciliation complete: ${totalTracksAdded} tracks added to ${playlistsWithAdditions.size} playlists`
        );

        return {
            playlistsUpdated: playlistsWithAdditions.size,
            tracksAdded: totalTracksAdded,
        };
    }

    /**
     * Get pending tracks count for a playlist
     */
    async getPendingTracksCount(playlistId: string): Promise<number> {
        return prisma.playlistPendingTrack.count({
            where: { playlistId },
        });
    }

    /**
     * Get pending tracks for a playlist
     */
    async getPendingTracks(playlistId: string): Promise<
        Array<{
            id: string;
            artist: string;
            title: string;
            album: string;
        }>
    > {
        const tracks = await prisma.playlistPendingTrack.findMany({
            where: { playlistId },
            orderBy: { sort: "asc" },
        });

        return tracks.map((t) => ({
            id: t.id,
            artist: t.spotifyArtist,
            title: t.spotifyTitle,
            album: t.spotifyAlbum,
        }));
    }
}

export const spotifyImportService = new SpotifyImportService();
