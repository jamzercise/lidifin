import { prisma } from "../../utils/db";
import type { TrackWithAlbumCover } from "./types";

/**
 * Fisher-Yates shuffle, then take the first `count` elements.
 * Returns a new array; the input is not mutated.
 */
export function randomSample<T>(array: T[], count: number): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [result[i], result[j]] = [result[j], result[i]];
    }
    return result.slice(0, count);
}

/**
 * Deterministic hash of a string into a non-negative integer.
 * Used to keep daily mixes stable per user/day.
 */
export function getSeededRandom(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        const char = seed.charCodeAt(i);
        hash = (hash << 5) - hash + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/**
 * Find tracks matching a list of genre patterns.
 * Strategy 1: track.lastfmTags / track.essentiaGenres (native String[] columns).
 * Strategy 2 (fallback): scan albums with non-empty genres / userGenres and
 * match in memory, merging artist userGenres as well.
 */
export async function findTracksByGenrePatterns(
    genrePatterns: string[],
    limit: number = 100
): Promise<TrackWithAlbumCover[]> {
    const tagPatterns = genrePatterns.map((g) => g.toLowerCase());

    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                { lastfmTags: { hasSome: tagPatterns } },
                { essentiaGenres: { hasSome: tagPatterns } },
            ],
        },
        include: {
            album: {
                select: {
                    coverUrl: true,
                    genres: true,
                    userGenres: true,
                    artist: {
                        select: {
                            userGenres: true,
                        },
                    },
                },
            },
        },
        take: limit,
    });

    if (tracks.length >= 15) {
        return tracks as TrackWithAlbumCover[];
    }

    const albumTracks = await prisma.track.findMany({
        where: {
            album: {
                OR: [
                    { genres: { not: { equals: null } } },
                    { userGenres: { not: { equals: null } } },
                ],
            },
        },
        include: {
            album: {
                select: {
                    coverUrl: true,
                    genres: true,
                    userGenres: true,
                    artist: {
                        select: {
                            userGenres: true,
                        },
                    },
                },
            },
        },
        take: limit * 3,
    });

    const genreMatched = albumTracks.filter((t) => {
        const albumGenres = t.album.genres as string[] | null;
        const albumUserGenres = (t.album.userGenres as string[] | null) || [];
        const artistUserGenres =
            (t.album.artist?.userGenres as string[] | null) || [];

        const allGenres = [
            ...(albumGenres || []),
            ...albumUserGenres,
            ...artistUserGenres,
        ];

        if (allGenres.length === 0) return false;

        return allGenres.some((ag) =>
            genrePatterns.some((gp) =>
                ag.toLowerCase().includes(gp.toLowerCase())
            )
        );
    });

    const existingIds = new Set(tracks.map((t) => t.id));
    const merged = [
        ...tracks,
        ...genreMatched.filter((t) => !existingIds.has(t.id)),
    ];

    return merged.slice(0, limit) as TrackWithAlbumCover[];
}
