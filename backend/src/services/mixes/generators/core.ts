import { prisma } from "@/utils/db";
import { logger } from "@/utils/logger";
import { normalizeArtistName } from "@/utils/artistNormalization";
import {
    getDecadeFromYear,
    getDecadeWhereClause,
    getEffectiveYear,
} from "@/utils/dateFilters";
import { lastFmService } from "@/services/lastfm";
import { resolveTrackReferences } from "@/services/jellyfin";
import { TRACK_LIMIT } from "../constants";
import { getMixColor } from "../colors";
import { getSeededRandom, randomSample } from "../helpers";
import type { ProgrammaticMix } from "../types";

/**
 * Generate ONE era-based mix (rotating decade daily)
 */
export async function generateEraMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const albums = await prisma.album.findMany({
        where: { tracks: { some: {} } },
        select: { year: true, originalYear: true, displayYear: true },
    });

    const decades = new Set<number>();
    albums.forEach((album) => {
        const effectiveYear = getEffectiveYear(album);
        if (effectiveYear) {
            const decade = getDecadeFromYear(effectiveYear);
            decades.add(decade);
        }
    });

    if (decades.size === 0) return null;

    const decadeArray = Array.from(decades).sort((a, b) => b - a);
    const decadeSeed = getSeededRandom(`era-${today}`);
    const selectedDecade = decadeArray[decadeSeed % decadeArray.length];

    const tracks = await prisma.track.findMany({
        where: {
            album: getDecadeWhereClause(selectedDecade),
        },
        include: {
            album: { select: { coverUrl: true } },
        },
    });

    if (tracks.length < 15) return null;

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `era-${selectedDecade}-${today}`,
        type: "era",
        name: `Your ${selectedDecade}s Mix`,
        description: `Random picks from the ${selectedDecade}s`,
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("era"),
    };
}

/**
 * Generate ONE genre-based mix (rotating genre daily)
 */
export async function generateGenreMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const genres = await prisma.genre.findMany({
        include: {
            _count: { select: { trackGenres: true } },
        },
        orderBy: {
            trackGenres: { _count: "desc" },
        },
        take: 20,
    });

    logger.debug(`[GENRE MIX] Found ${genres.length} genres total`);
    const validGenres = genres.filter((g) => g._count.trackGenres >= 5);
    logger.debug(`[GENRE MIX] ${validGenres.length} genres have >= 5 tracks`);
    if (validGenres.length === 0) {
        logger.debug(`[GENRE MIX] FAILED: No genres with enough tracks`);
        return null;
    }

    const genreSeed = getSeededRandom(`genre-${today}`);
    const selectedGenre = validGenres[genreSeed % validGenres.length];

    const trackGenres = await prisma.trackGenre.findMany({
        where: { genreId: selectedGenre.id },
        include: {
            track: {
                include: {
                    album: { select: { coverUrl: true } },
                },
            },
        },
    });

    const tracks = trackGenres.map((tg) => tg.track);
    if (tracks.length < 5) return null;

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `genre-${selectedGenre.id}-${today}`,
        type: "genre",
        name: `Your ${selectedGenre.name} Mix`,
        description: `Random ${selectedGenre.name} picks`,
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("genre"),
    };
}

/**
 * Generate "Your Top 20" mix
 */
export async function generateTopTracksMix(
    userId: string
): Promise<ProgrammaticMix | null> {
    const playStats = await prisma.play.groupBy({
        by: ["trackId"],
        where: { userId },
        _count: { trackId: true },
        orderBy: { _count: { trackId: "desc" } },
        take: TRACK_LIMIT,
    });

    logger.debug(
        `[TOP TRACKS MIX] Found ${playStats.length} unique played tracks`
    );
    if (playStats.length < 5) {
        logger.debug(
            `[TOP TRACKS MIX] FAILED: Only ${playStats.length} tracks (need at least 5)`
        );
        return null;
    }

    const trackIds = playStats.map((p) => p.trackId);
    const hasJellyfinIds = trackIds.some((id) => id.startsWith("jellyfin:"));

    let orderedTracks: { id: string; album: { coverUrl: string | null } }[] = [];
    let coverUrls: string[] = [];

    if (hasJellyfinIds) {
        const resolved = await resolveTrackReferences(trackIds);
        orderedTracks = trackIds
            .map((id, i) => {
                const r = resolved[i];
                if (!r) return null;
                return {
                    id: r.id,
                    album: { coverUrl: r.album.coverArt },
                };
            })
            .filter((t): t is NonNullable<typeof t> => t !== null);
        coverUrls = orderedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);
    } else {
        const tracks = await prisma.track.findMany({
            where: { id: { in: trackIds } },
            include: {
                album: { select: { coverUrl: true } },
            },
        });
        orderedTracks = trackIds
            .map((id) => tracks.find((t) => t.id === id))
            .filter((t): t is NonNullable<typeof t> => t !== undefined);
        coverUrls = orderedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);
    }

    if (orderedTracks.length < 5) {
        logger.debug(
            `[TOP TRACKS MIX] FAILED: Only ${orderedTracks.length} resolvable tracks (need at least 5)`
        );
        return null;
    }

    return {
        id: "top-tracks",
        type: "top-tracks",
        name: "Your Top 20",
        description: "Your most played tracks",
        trackIds: orderedTracks.map((t) => t.id),
        coverUrls,
        trackCount: orderedTracks.length,
        color: getMixColor("top-tracks"),
    };
}

/**
 * Generate "Rediscover" mix with daily rotation
 */
export async function generateRediscoverMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const playCounts = await prisma.$queryRaw<{ trackId: string; c: number }[]>`
        SELECT "trackId", COUNT(*)::int as c FROM "Play"
        WHERE "userId" = ${userId} AND "trackId" NOT LIKE 'jellyfin:%'
        GROUP BY "trackId"
    `;
    const playCountMap = new Map(playCounts.map((r) => [r.trackId, r.c]));

    const allTracks = await prisma.track.findMany({
        include: {
            album: { select: { coverUrl: true } },
        },
    });

    const underplayedTracks = allTracks.filter(
        (t) => (playCountMap.get(t.id) ?? 0) <= 2
    );

    if (underplayedTracks.length < 5) return null;

    const seed = getSeededRandom(`rediscover-${today}`);
    let random = seed;
    const shuffled = underplayedTracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `rediscover-${today}`,
        type: "rediscover",
        name: "Rediscover",
        description: "Hidden gems you rarely play",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("rediscover"),
    };
}

/**
 * Generate "More Like X" mix
 */
export async function generateArtistSimilarMix(
    userId: string
): Promise<ProgrammaticMix | null> {
    const recentPlays = await prisma.play.findMany({
        where: {
            userId,
            playedAt: {
                gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
            },
        },
    });

    logger.debug(
        `[ARTIST SIMILAR MIX] Found ${recentPlays.length} plays in last 7 days`
    );
    if (recentPlays.length === 0) {
        logger.debug(`[ARTIST SIMILAR MIX] FAILED: No plays in last 7 days`);
        return null;
    }

    const resolved = await resolveTrackReferences(
        recentPlays.map((p) => p.trackId).filter(Boolean)
    );
    const artistPlayCounts = new Map<string, number>();
    for (let i = 0; i < recentPlays.length; i++) {
        const artistId = resolved[i]?.artist?.id;
        if (!artistId) continue;
        artistPlayCounts.set(
            artistId,
            (artistPlayCounts.get(artistId) || 0) + 1
        );
    }

    const sorted = Array.from(artistPlayCounts.entries()).sort(
        (a, b) => b[1] - a[1]
    );
    if (sorted.length === 0) return null;
    const topArtistId = sorted[0][0];
    if (topArtistId.startsWith("jellyfin:")) {
        logger.debug(
            `[ARTIST SIMILAR MIX] Top artist is Jellyfin; skip native similar`
        );
        return null;
    }

    const topArtist = await prisma.artist.findUnique({
        where: { id: topArtistId },
    });

    if (!topArtist || !topArtist.name) {
        logger.debug(
            `[ARTIST SIMILAR MIX] FAILED: Top artist not found or has no name`
        );
        return null;
    }

    logger.debug(`[ARTIST SIMILAR MIX] Top artist: ${topArtist.name}`);

    try {
        const similarArtists = await lastFmService.getSimilarArtists(
            topArtist.mbid || "",
            topArtist.name,
            10
        );

        logger.debug(
            `[ARTIST SIMILAR MIX] Last.fm returned ${similarArtists.length} similar artists`
        );

        const similarArtistNormalized = similarArtists.map((a) =>
            normalizeArtistName(a.name)
        );
        const artistsInLibrary = await prisma.artist.findMany({
            where: { normalizedName: { in: similarArtistNormalized } },
            include: {
                albums: {
                    include: {
                        tracks: {
                            include: {
                                album: { select: { coverUrl: true } },
                            },
                        },
                    },
                },
            },
        });

        logger.debug(
            `[ARTIST SIMILAR MIX] Found ${artistsInLibrary.length} similar artists in library`
        );

        const tracks = artistsInLibrary.flatMap((artist) =>
            artist.albums.flatMap((album) => album.tracks)
        );

        logger.debug(
            `[ARTIST SIMILAR MIX] Total tracks from similar artists: ${tracks.length}`
        );

        if (tracks.length < 5) {
            logger.debug(
                `[ARTIST SIMILAR MIX] FAILED: Only ${tracks.length} tracks (need at least 5)`
            );
            return null;
        }

        const selectedTracks = randomSample(tracks, TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `artist-similar-${topArtistId}`,
            type: "artist-similar",
            name: `More Like ${topArtist.name}`,
            description: `Similar artists you might enjoy`,
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("artist-similar"),
        };
    } catch (error) {
        logger.error("Failed to generate artist similar mix:", error);
        return null;
    }
}

/**
 * Generate random discovery mix with daily rotation
 */
export async function generateRandomDiscoveryMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const totalAlbums = await prisma.album.count({
        where: { tracks: { some: {} } },
    });

    if (totalAlbums < 10) return null;

    const seed = getSeededRandom(`random-${today}`) % totalAlbums;

    const randomAlbums = await prisma.album.findMany({
        where: { tracks: { some: {} } },
        include: {
            tracks: {
                include: {
                    album: { select: { coverUrl: true } },
                },
            },
        },
        skip: seed,
        take: 5,
    });

    const tracks = randomAlbums.flatMap((album) => album.tracks);
    if (tracks.length < 5) return null;

    const selectedTracks = randomSample(tracks, TRACK_LIMIT);
    const coverUrls = randomAlbums
        .filter((a) => a.coverUrl)
        .slice(0, 4)
        .map((a) => a.coverUrl!);

    return {
        id: `random-discovery-${today}`,
        type: "discovery",
        name: "Random Discovery",
        description: "Random albums to explore today",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("discovery"),
    };
}
