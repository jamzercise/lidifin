import { prisma } from "@/utils/db";
import { logger } from "@/utils/logger";
import { TRACK_LIMIT } from "../constants";
import { getMixColor } from "../colors";
import { findTracksByGenrePatterns, getSeededRandom } from "../helpers";
import type { ProgrammaticMix } from "../types";

/**
 * Generate "Happy Vibes" mix using audio analysis
 * Enhanced mode: Uses ML moodHappy prediction
 * Standard mode: Uses valence/energy heuristics
 */
export async function generateHappyMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const enhancedTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            moodHappy: { gte: 0.6 },
            moodSad: { lte: 0.3 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = enhancedTracks;
    logger.debug(`[HAPPY MIX] Enhanced mode: Found ${tracks.length} tracks`);

    if (tracks.length < 15) {
        const standardTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                valence: { gte: 0.6 },
                energy: { gte: 0.5 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...standardTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[HAPPY MIX] After Standard fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const happyGenres = [
            "pop",
            "funk",
            "disco",
            "soul",
            "reggae",
            "ska",
            "motown",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            happyGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[HAPPY MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(`[HAPPY MIX] FAILED: Only ${tracks.length} tracks found`);
        return null;
    }

    const seed = getSeededRandom(`happy-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `happy-${today}`,
        type: "happy",
        name: "Happy Vibes",
        description: "Feel-good tracks to brighten your day",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("happy"),
    };
}

/**
 * Generate "Melancholy" mix using audio analysis
 * Enhanced mode: Uses ML moodSad prediction
 * Standard mode: Uses valence heuristics + minor key
 */
export async function generateMelancholyMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const enhancedTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            moodSad: { gte: 0.5 },
            moodHappy: { lte: 0.4 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 150,
    });
    logger.debug(
        `[MELANCHOLY MIX] Enhanced mode: Found ${enhancedTracks.length} tracks`
    );

    if (enhancedTracks.length >= 15) {
        tracks = enhancedTracks;
    } else {
        logger.debug(`[MELANCHOLY MIX] Falling back to Standard mode`);
        const audioTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                valence: { lte: 0.35 },
                energy: { lte: 0.6 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 150,
        });
        logger.debug(
            `[MELANCHOLY MIX] Standard mode: Found ${audioTracks.length} low-valence tracks`
        );

        tracks = audioTracks.filter((t) => {
            const hasMinorKey = t.keyScale === "minor";
            const hasSadTags = t.moodTags?.some((tag: string) =>
                [
                    "sad",
                    "melancholic",
                    "melancholy",
                    "moody",
                    "atmospheric",
                ].includes(tag.toLowerCase())
            );
            const hasLastfmSadTags = t.lastfmTags?.some((tag: string) =>
                [
                    "sad",
                    "melancholic",
                    "melancholy",
                    "depressing",
                    "emotional",
                    "heartbreak",
                ].includes(tag.toLowerCase())
            );
            return hasMinorKey || hasSadTags || hasLastfmSadTags;
        });
        logger.debug(
            `[MELANCHOLY MIX] After tag filter: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const sadGenres = [
            "blues",
            "soul",
            "ballad",
            "singer-songwriter",
            "slowcore",
            "sadcore",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            sadGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[MELANCHOLY MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[MELANCHOLY MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const sortedTracks = tracks.sort((a, b) => {
        const aScore =
            (a.valence || 0.5) * 2 +
            (a.energy || 0.5) +
            (a.keyScale === "minor" ? 0 : 0.3);
        const bScore =
            (b.valence || 0.5) * 2 +
            (b.energy || 0.5) +
            (b.keyScale === "minor" ? 0 : 0.3);
        return aScore - bScore;
    });

    const seed = getSeededRandom(`melancholy-${today}`);
    let random = seed;
    const shuffled = sortedTracks.slice(0, 50).sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `melancholy-${today}`,
        type: "melancholy",
        name: "Melancholy",
        description: "Introspective tracks for reflective moments",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("melancholy"),
    };
}

/**
 * Generate "Dance Floor" mix using audio analysis
 * Criteria: danceability >= 0.7, BPM 110-140
 * Fallback: dance/electronic genres if no audio analysis
 */
export async function generateDanceFloorMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const audioTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            danceability: { gte: 0.7 },
            bpm: { gte: 110, lte: 140 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = audioTracks;
    logger.debug(
        `[DANCE FLOOR MIX] Found ${tracks.length} tracks from audio analysis`
    );

    if (tracks.length < 15) {
        const danceGenres = [
            "dance",
            "electronic",
            "edm",
            "house",
            "disco",
            "techno",
            "pop",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            danceGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[DANCE FLOOR MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[DANCE FLOOR MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`dance-floor-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `dance-floor-${today}`,
        type: "dance-floor",
        name: "Dance Floor",
        description: "High danceability tracks with perfect tempo",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("dance-floor"),
    };
}

/**
 * Generate "Acoustic Afternoon" mix using audio analysis
 * Criteria: acousticness >= 0.6, energy 0.3-0.6
 * Fallback: acoustic/folk/singer-songwriter genres
 */
export async function generateAcousticMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const audioTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            acousticness: { gte: 0.6 },
            energy: { gte: 0.3, lte: 0.6 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = audioTracks;
    logger.debug(
        `[ACOUSTIC MIX] Found ${tracks.length} tracks from audio analysis`
    );

    if (tracks.length < 15) {
        const acousticGenres = [
            "acoustic",
            "folk",
            "singer-songwriter",
            "unplugged",
            "indie folk",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            acousticGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[ACOUSTIC MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[ACOUSTIC MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`acoustic-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `acoustic-${today}`,
        type: "acoustic",
        name: "Acoustic Afternoon",
        description: "Stripped-down, organic sounds",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("acoustic"),
    };
}

/**
 * Generate "Instrumental Focus" mix using audio analysis
 * Criteria: instrumentalness >= 0.7, energy 0.3-0.6
 * Fallback: instrumental/classical/soundtrack genres
 */
export async function generateInstrumentalMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const audioTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            instrumentalness: { gte: 0.7 },
            energy: { gte: 0.3, lte: 0.6 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = audioTracks;
    logger.debug(
        `[INSTRUMENTAL MIX] Found ${tracks.length} tracks from audio analysis`
    );

    if (tracks.length < 15) {
        const instrumentalGenres = [
            "instrumental",
            "classical",
            "soundtrack",
            "score",
            "ambient",
            "post-rock",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            instrumentalGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[INSTRUMENTAL MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[INSTRUMENTAL MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`instrumental-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `instrumental-${today}`,
        type: "instrumental",
        name: "Instrumental Focus",
        description: "No vocals, pure concentration",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("instrumental"),
    };
}

/**
 * Generate mix based on a Last.fm mood tag.
 * Generic helper: caller supplies the tag, name and description.
 *
 * NOTE: Currently unreferenced. Kept for backward-compat in case
 * external callers exist; safe to delete in a follow-up.
 */
export async function generateMoodTagMix(
    userId: string,
    today: string,
    moodTag: string,
    mixName: string,
    mixDescription: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            lastfmTags: {
                has: moodTag,
            },
        },
        include: {
            album: { select: { coverUrl: true } },
        },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const seed = getSeededRandom(`mood-${moodTag}-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `mood-${moodTag}-${today}`,
        type: `mood-${moodTag}`,
        name: mixName,
        description: mixDescription,
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("mood"),
    };
}

/**
 * Generate "Road Trip" mix - using tags + audio analysis fallbacks
 */
export async function generateRoadTripMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const taggedTracks = await prisma.track.findMany({
        where: {
            OR: [
                {
                    lastfmTags: {
                        hasSome: [
                            "driving",
                            "road trip",
                            "travel",
                            "summer",
                        ],
                    },
                },
                { moodTags: { hasSome: ["energetic", "upbeat", "happy"] } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = taggedTracks;
    logger.debug(`[ROAD TRIP MIX] Found ${tracks.length} tracks from tags`);

    if (tracks.length < 15) {
        const audioTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                energy: { gte: 0.5, lte: 0.8 },
                bpm: { gte: 100, lte: 130 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...audioTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[ROAD TRIP MIX] After audio fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const roadTripGenres = [
            "rock",
            "pop",
            "indie",
            "alternative",
            "classic rock",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            roadTripGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[ROAD TRIP MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[ROAD TRIP MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`road-trip-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedTracks = shuffled.slice(0, TRACK_LIMIT);
    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `road-trip-${today}`,
        type: "road-trip",
        name: "Road Trip",
        description: "Perfect soundtrack for the open road",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("road-trip"),
    };
}
