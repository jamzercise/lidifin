import { prisma } from "@/utils/db";
import { logger } from "@/utils/logger";
import {
    DAILY_TRACK_LIMIT,
    MIN_TRACKS_DAILY,
    MIN_TRACKS_WEEKLY,
    TRACK_LIMIT,
    WEEKLY_TRACK_LIMIT,
} from "../constants";
import { getMixColor } from "../colors";
import { findTracksByGenrePatterns, getSeededRandom } from "../helpers";
import type { ProgrammaticMix } from "../types";

/**
 * Generate "Party Playlist" mix - upbeat dance, electronic, pop tracks
 * Uses multiple strategies: Genre table, album.genre, audio analysis
 */
export async function generatePartyMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const partyGenres = [
        "dance",
        "electronic",
        "pop",
        "disco",
        "house",
        "techno",
        "edm",
        "funk",
        "electro",
        "dance pop",
        "club",
        "eurodance",
        "trance",
        "dubstep",
        "drum and bass",
        "hip hop",
    ];

    let tracks: any[] = [];

    const genres = await prisma.genre.findMany({
        where: { name: { in: partyGenres, mode: "insensitive" } },
        include: {
            trackGenres: {
                include: {
                    track: {
                        include: { album: { select: { coverUrl: true } } },
                    },
                },
                take: 50,
            },
        },
    });
    tracks = genres.flatMap((g) => g.trackGenres.map((tg) => tg.track));
    logger.debug(`[PARTY MIX] Found ${tracks.length} tracks from Genre table`);

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            partyGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[PARTY MIX] After album genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const audioTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                OR: [
                    { danceability: { gte: 0.7 } },
                    {
                        AND: [
                            { energy: { gte: 0.7 } },
                            { bpm: { gte: 110 } },
                        ],
                    },
                ],
            },
            include: { album: { select: { coverUrl: true } } },
            take: 50,
        });
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...audioTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[PARTY MIX] After audio analysis fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(`[PARTY MIX] FAILED: Only ${tracks.length} tracks found`);
        return null;
    }

    const seed = getSeededRandom(`party-${today}`);
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
        id: `party-${today}`,
        type: "dance-floor",
        name: "Party Playlist",
        description: "High energy dance, EDM, and pop hits",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("dance-floor"),
    };
}

/**
 * Generate "Chill Mix" - relaxing, mellow tracks
 * Enhanced mode: Uses ML moodRelaxed prediction
 * Standard mode: Uses energy/arousal heuristics
 */
export async function generateChillMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            AND: [
                { moodRelaxed: { gte: 0.5 } },
                { moodAggressive: { lte: 0.3 } },
                { energy: { lte: 0.55 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    logger.debug(`[CHILL MIX] Enhanced mode: Found ${tracks.length} tracks`);

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(`[CHILL MIX] Falling back to Standard mode`);
        tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                AND: [
                    { energy: { lte: 0.55 } },
                    { bpm: { lte: 115 } },
                    {
                        OR: [
                            { arousal: { lte: 0.55 } },
                            { acousticness: { gte: 0.3 } },
                            { valence: { lte: 0.65 } },
                        ],
                    },
                ],
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        logger.debug(
            `[CHILL MIX] Standard mode: Found ${tracks.length} tracks`
        );
    }

    logger.debug(
        `[CHILL MIX] Total: ${tracks.length} tracks matching criteria`
    );

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(
            `[CHILL MIX] FAILED: Only ${tracks.length} tracks (need ${MIN_TRACKS_DAILY})`
        );
        return null;
    }

    const seed = getSeededRandom(`chill-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const isWeekly = tracks.length >= MIN_TRACKS_WEEKLY;
    const trackLimit = isWeekly ? WEEKLY_TRACK_LIMIT : DAILY_TRACK_LIMIT;
    const selectedTracks = shuffled.slice(0, trackLimit);

    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `chill-${today}`,
        type: "chill",
        name: "Chill Mix",
        description: "Relax and unwind with mellow vibes",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("chill"),
    };
}

/**
 * Generate "Workout Mix" - high energy, motivational tracks
 * Enhanced mode: Uses ML high arousal + moodAggressive
 * Standard mode: Uses energy/BPM heuristics + genres
 */
export async function generateWorkoutMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const workoutGenres = [
        "rock",
        "metal",
        "hard rock",
        "alternative rock",
        "punk",
        "hip hop",
        "rap",
        "trap",
        "hardcore",
        "metalcore",
        "industrial",
        "drum and bass",
        "hardstyle",
        "nu metal",
        "electronic",
        "edm",
        "house",
        "techno",
        "pop punk",
    ];

    let tracks: any[] = [];

    const enhancedTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            AND: [
                { arousal: { gte: 0.6 } },
                { energy: { gte: 0.6 } },
                { bpm: { gte: 110 } },
                { moodRelaxed: { lte: 0.4 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = enhancedTracks;
    logger.debug(`[WORKOUT MIX] Enhanced mode: Found ${tracks.length} tracks`);

    if (tracks.length < 15) {
        logger.debug(`[WORKOUT MIX] Falling back to Standard mode`);
        const audioTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                OR: [
                    {
                        AND: [
                            { energy: { gte: 0.65 } },
                            { bpm: { gte: 115 } },
                        ],
                    },
                    {
                        moodTags: {
                            hasSome: [
                                "workout",
                                "energetic",
                                "upbeat",
                                "powerful",
                            ],
                        },
                    },
                ],
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
            `[WORKOUT MIX] Standard mode: Total ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const genres = await prisma.genre.findMany({
            where: { name: { in: workoutGenres, mode: "insensitive" } },
            include: {
                trackGenres: {
                    include: {
                        track: {
                            include: {
                                album: { select: { coverUrl: true } },
                            },
                        },
                    },
                    take: 50,
                },
            },
        });
        const genreTracks = genres.flatMap((g) =>
            g.trackGenres.map((tg) => tg.track)
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...genreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(`[WORKOUT MIX] After Genre table: ${tracks.length} tracks`);
    }

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            workoutGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[WORKOUT MIX] After album genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(`[WORKOUT MIX] FAILED: Only ${tracks.length} tracks found`);
        return null;
    }

    const seed = getSeededRandom(`workout-${today}`);
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
        id: `workout-${today}`,
        type: "workout",
        name: "Workout Mix",
        description: "High energy tracks to power your workout",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("workout"),
    };
}

/**
 * Generate "Focus Mix" - instrumental, minimal vocals, concentration music
 * Uses multiple strategies: Genre table, album.genre, audio analysis
 */
export async function generateFocusMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const focusGenres = [
        "classical",
        "instrumental",
        "jazz",
        "piano",
        "ambient",
        "post-rock",
        "math rock",
        "soundtrack",
        "score",
        "contemporary classical",
        "minimal",
        "modern classical",
        "neoclassical",
    ];

    let tracks: any[] = [];

    const genres = await prisma.genre.findMany({
        where: { name: { in: focusGenres, mode: "insensitive" } },
        include: {
            trackGenres: {
                include: {
                    track: {
                        include: { album: { select: { coverUrl: true } } },
                    },
                },
                take: 50,
            },
        },
    });
    tracks = genres.flatMap((g) => g.trackGenres.map((tg) => tg.track));
    logger.debug(`[FOCUS MIX] Found ${tracks.length} tracks from Genre table`);

    if (tracks.length < 15) {
        const albumGenreTracks = await findTracksByGenrePatterns(
            focusGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[FOCUS MIX] After album genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        const audioTracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                instrumentalness: { gte: 0.5 },
                energy: { gte: 0.2, lte: 0.7 },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 50,
        });
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...audioTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[FOCUS MIX] After audio analysis fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(`[FOCUS MIX] FAILED: Only ${tracks.length} tracks found`);
        return null;
    }

    const seed = getSeededRandom(`focus-${today}`);
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
        id: `focus-${today}`,
        type: "focus-flow",
        name: "Focus Mix",
        description: "Concentration music for deep work",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("focus-flow"),
    };
}

/**
 * Generate "High Energy" mix using audio analysis
 * Criteria: energy >= 0.7, BPM >= 120
 * Fallback: energetic genres if no audio analysis
 */
export async function generateHighEnergyMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks: any[] = [];

    const audioTracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            energy: { gte: 0.7 },
            bpm: { gte: 120 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });
    tracks = audioTracks;
    logger.debug(
        `[HIGH ENERGY MIX] Found ${tracks.length} tracks from audio analysis`
    );

    if (tracks.length < 15) {
        const energyGenres = [
            "rock",
            "metal",
            "punk",
            "electronic",
            "edm",
            "dance",
            "hip hop",
            "trap",
        ];
        const albumGenreTracks = await findTracksByGenrePatterns(
            energyGenres,
            100
        );
        const existingIds = new Set(tracks.map((t) => t.id));
        tracks = [
            ...tracks,
            ...albumGenreTracks.filter((t) => !existingIds.has(t.id)),
        ];
        logger.debug(
            `[HIGH ENERGY MIX] After genre fallback: ${tracks.length} tracks`
        );
    }

    if (tracks.length < 15) {
        logger.debug(
            `[HIGH ENERGY MIX] FAILED: Only ${tracks.length} tracks found`
        );
        return null;
    }

    const seed = getSeededRandom(`high-energy-${today}`);
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
        id: `high-energy-${today}`,
        type: "workout",
        name: "High Energy",
        description: "Fast-paced tracks to get you moving",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("workout"),
    };
}

/**
 * Generate "Late Night" mix using audio analysis
 * Enhanced mode: Uses ML moodRelaxed and low moodAggressive
 * Standard mode: Uses energy, BPM, arousal heuristics
 */
export async function generateLateNightMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    let tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            AND: [
                { moodRelaxed: { gte: 0.5 } },
                { moodAggressive: { lte: 0.4 } },
                { energy: { lte: 0.5 } },
                { bpm: { lte: 110 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    logger.debug(
        `[LATE NIGHT MIX] Enhanced mode: Found ${tracks.length} tracks`
    );

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(`[LATE NIGHT MIX] Falling back to Standard mode`);
        tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                AND: [
                    { energy: { lte: 0.45 } },
                    { bpm: { lte: 110 } },
                    {
                        OR: [
                            { arousal: { lte: 0.5 } },
                            { valence: { lte: 0.6 } },
                            { acousticness: { gte: 0.3 } },
                        ],
                    },
                ],
            },
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });
        logger.debug(
            `[LATE NIGHT MIX] Standard mode: Found ${tracks.length} tracks`
        );
    }

    logger.debug(
        `[LATE NIGHT MIX] Total: ${tracks.length} tracks matching criteria`
    );

    if (tracks.length < MIN_TRACKS_DAILY) {
        logger.debug(
            `[LATE NIGHT MIX] FAILED: Only ${tracks.length} tracks (need ${MIN_TRACKS_DAILY})`
        );
        return null;
    }

    const seed = getSeededRandom(`late-night-${today}`);
    let random = seed;
    const shuffled = tracks.sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const isWeekly = tracks.length >= MIN_TRACKS_WEEKLY;
    const trackLimit = isWeekly ? WEEKLY_TRACK_LIMIT : DAILY_TRACK_LIMIT;
    const selectedTracks = shuffled.slice(0, trackLimit);

    const coverUrls = selectedTracks
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `late-night-${today}`,
        type: "late-night",
        name: "Late Night",
        description: "Mellow vibes for the quiet hours",
        trackIds: selectedTracks.map((t) => t.id),
        coverUrls,
        trackCount: selectedTracks.length,
        color: getMixColor("late-night"),
    };
}
