import { prisma } from "../../../utils/db";
import { DAILY_TRACK_LIMIT, MIN_TRACKS_DAILY } from "../constants";
import { getMixColor } from "../colors";
import { randomSample } from "../helpers";
import type { ProgrammaticMix } from "../types";

/**
 * "Sad Girl Sundays" - Melancholic introspection.
 * Only available on Sundays.
 */
export async function generateSadGirlSundays(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 0) return null;

    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { lte: 0.35 } },
                        { keyScale: "minor" },
                    ],
                },
                {
                    AND: [
                        { valence: { lte: 0.3 } },
                        { arousal: { lte: 0.4 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "sad",
                            "melancholic",
                            "heartbreak",
                            "emotional",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `sad-girl-sundays-${today}`,
        type: "sad-girl-sundays",
        name: "Sad Girl Sundays",
        description: "Melancholic introspection and feelings",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("sad-girl-sundays"),
    };
}

/**
 * "Main Character Energy" - Walking through life like a movie.
 */
export async function generateMainCharacterEnergy(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.55 } },
                        { energy: { gte: 0.55 } },
                        { danceability: { gte: 0.5 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "empowering",
                            "confident",
                            "uplifting",
                            "anthemic",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `main-character-${today}`,
        type: "main-character",
        name: "Main Character Energy",
        description: "You're the protagonist today",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("main-character"),
    };
}

/**
 * "Villain Era" - Dark, empowering, dramatic.
 */
export async function generateVillainEra(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [{ keyScale: "minor" }, { energy: { gte: 0.65 } }],
                },
                {
                    moodTags: {
                        hasSome: ["aggressive", "dark", "intense"],
                    },
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "dark",
                            "aggressive",
                            "intense",
                            "powerful",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `villain-era-${today}`,
        type: "villain-era",
        name: "Villain Era",
        description: "Embrace your dark side",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("villain-era"),
    };
}

/**
 * "3AM Thoughts" - Late night overthinking.
 */
export async function generate3AMThoughts(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { arousal: { lte: 0.4 } },
                { energy: { lte: 0.5 } },
                { bpm: { lte: 110 } },
                {
                    OR: [
                        { valence: { lte: 0.5 } },
                        { acousticness: { gte: 0.3 } },
                    ],
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < MIN_TRACKS_DAILY) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `3am-thoughts-${today}`,
        type: "3am-thoughts",
        name: "3AM Thoughts",
        description: "Late night overthinking companion",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("3am-thoughts"),
    };
}

/**
 * "Hot Girl Walk" - Confident, upbeat cardio.
 */
export async function generateHotGirlWalk(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { danceability: { gte: 0.65 } },
                        { bpm: { gte: 95, lte: 135 } },
                        { energy: { gte: 0.55 } },
                    ],
                },
                {
                    AND: [
                        { valence: { gte: 0.6 } },
                        { energy: { gte: 0.6 } },
                    ],
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `hot-girl-walk-${today}`,
        type: "hot-girl-walk",
        name: "Hot Girl Walk",
        description: "Confidence boost for your walk",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("confidence-boost"),
    };
}

/**
 * "Rage Cleaning" - Aggressive productivity.
 */
export async function generateRageCleaning(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { energy: { gte: 0.75 } },
                        { arousal: { gte: 0.65 } },
                        { bpm: { gte: 125 } },
                    ],
                },
                {
                    AND: [
                        { energy: { gte: 0.8 } },
                        { danceability: { gte: 0.6 } },
                    ],
                },
                {
                    moodTags: { hasSome: ["aggressive", "energetic"] },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `rage-cleaning-${today}`,
        type: "rage-cleaning",
        name: "Rage Cleaning",
        description: "Aggressive productivity fuel",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("workout"),
    };
}

/**
 * "Golden Hour" - Warm, hopeful, sunset vibes.
 */
export async function generateGoldenHour(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.45 } },
                        { acousticness: { gte: 0.35 } },
                        { energy: { gte: 0.25, lte: 0.65 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: ["warm", "sunset", "dreamy", "peaceful"],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `golden-hour-${today}`,
        type: "golden-hour",
        name: "Golden Hour",
        description: "Warm sunset vibes",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("golden-hour"),
    };
}

/**
 * "Shower Karaoke" - Belters you can't help but sing.
 */
export async function generateShowerKaraoke(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { instrumentalness: { lte: 0.35 } },
                { energy: { gte: 0.55 } },
                { valence: { gte: 0.45 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `shower-karaoke-${today}`,
        type: "shower-karaoke",
        name: "Shower Karaoke",
        description: "Belters you can't help but sing",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("happy"),
    };
}

/**
 * "In My Feelings" - Deep emotional processing.
 */
export async function generateInMyFeelings(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { lte: 0.4 } },
                        { arousal: { lte: 0.55 } },
                        { acousticness: { gte: 0.25 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "emotional",
                            "heartbreak",
                            "feelings",
                            "vulnerable",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `in-my-feelings-${today}`,
        type: "in-my-feelings",
        name: "In My Feelings",
        description: "Let it all out",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("heartbreak-hotel"),
    };
}

/**
 * "Midnight Drive" - Cruising at night, contemplative.
 */
export async function generateMidnightDrive(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { energy: { gte: 0.3, lte: 0.65 } },
                { bpm: { gte: 80, lte: 130 } },
                {
                    OR: [
                        { arousal: { lte: 0.6 } },
                        { valence: { gte: 0.3, lte: 0.7 } },
                    ],
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < MIN_TRACKS_DAILY) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `midnight-drive-${today}`,
        type: "midnight-drive",
        name: "Midnight Drive",
        description: "Perfect for late night cruising",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("night-drive"),
    };
}

/**
 * "Coffee Shop Vibes" - Cozy background energy.
 */
export async function generateCoffeeShopVibes(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { energy: { lte: 0.55 } },
                { bpm: { lte: 120 } },
                {
                    OR: [
                        { acousticness: { gte: 0.35 } },
                        { instrumentalness: { gte: 0.25 } },
                    ],
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < MIN_TRACKS_DAILY) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `coffee-shop-${today}`,
        type: "coffee-shop",
        name: "Coffee Shop Vibes",
        description: "Cozy background music",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("coffee-shop"),
    };
}

/**
 * "Romanticize Your Life" - Dreamy, aesthetic moments.
 */
export async function generateRomanticizeYourLife(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.35, lte: 0.75 } },
                        { arousal: { gte: 0.25, lte: 0.65 } },
                        { acousticness: { gte: 0.25 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: [
                            "dreamy",
                            "aesthetic",
                            "cinematic",
                            "romantic",
                        ],
                    },
                },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `romanticize-${today}`,
        type: "romanticize",
        name: "Romanticize Your Life",
        description: "Make every moment aesthetic",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("golden-hour"),
    };
}

/**
 * "That Girl Era" - Self-improvement anthem energy.
 */
export async function generateThatGirlEra(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            AND: [
                { valence: { gte: 0.55 } },
                { energy: { gte: 0.45 } },
                { danceability: { gte: 0.45 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 50,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `that-girl-era-${today}`,
        type: "that-girl-era",
        name: "That Girl Era",
        description: "Self-improvement mode activated",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("confidence-boost"),
    };
}

/**
 * "Unhinged" - Chaotic, weird, fun. High variance in features.
 */
export async function generateUnhinged(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            OR: [
                { energy: { gte: 0.85 } },
                { energy: { lte: 0.15 } },
                { valence: { gte: 0.9 } },
                { valence: { lte: 0.1 } },
                { bpm: { gte: 160 } },
                { bpm: { lte: 70 } },
                { danceability: { gte: 0.9 } },
            ],
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    if (tracks.length < 8) return null;

    const shuffled = randomSample(tracks, DAILY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `unhinged-${today}`,
        type: "unhinged",
        name: "Unhinged",
        description: "Embrace the chaos",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("dance-floor"),
    };
}
