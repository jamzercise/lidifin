import { prisma } from "@/utils/db";
import { isJellyfinMusicSource } from "@/services/jellyfin";
import { WEEKLY_TRACK_LIMIT } from "../constants";
import { getMixColor } from "../colors";
import { getSeededRandom, randomSample } from "../helpers";
import * as jfVibe from "../jellyfinVibeDayAdvancedMixes";
import type { ProgrammaticMix } from "../types";

/**
 * "Deep Cuts" - Hidden gems from your library.
 * Tracks with no plays, then fallback to tracks with <=3 plays.
 */
export async function generateDeepCuts(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    if (await isJellyfinMusicSource()) {
        return jfVibe.generateDeepCutsJellyfin(today);
    }
    const unplayedIds = await prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Track" t
        LEFT JOIN "Play" p ON p."trackId" = t.id
        WHERE p.id IS NULL
        LIMIT 200
    `;
    const unplayedIdSet = new Set(unplayedIds.map((r) => r.id));

    const tracks = await prisma.track.findMany({
        where: { id: { in: [...unplayedIdSet] } },
        include: {
            album: {
                select: {
                    coverUrl: true,
                    artist: { select: { id: true } },
                },
            },
        },
        take: 200,
    });

    if (tracks.length < 15) {
        const playCounts = await prisma.$queryRaw<
            { trackId: string; c: number }[]
        >`
            SELECT "trackId", COUNT(*)::int as c FROM "Play"
            WHERE "trackId" NOT LIKE 'jellyfin:%'
            GROUP BY "trackId"
            HAVING COUNT(*) <= 3
        `;
        const lowPlayIdSet = new Set(playCounts.map((r) => r.trackId));
        const lowPlayTracks = await prisma.track.findMany({
            where: { id: { in: [...lowPlayIdSet] } },
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 200,
        });

        const filtered = lowPlayTracks.map((t) => ({ ...t, album: t.album }));

        if (filtered.length < 15) return null;

        const shuffled = randomSample(filtered, WEEKLY_TRACK_LIMIT);
        const coverUrls = shuffled
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `deep-cuts-${today}`,
            type: "deep-cuts",
            name: "Deep Cuts",
            description: "Hidden gems waiting to be discovered",
            trackIds: shuffled.map((t) => t.id),
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor("rediscover"),
        };
    }

    const shuffled = randomSample(tracks, WEEKLY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `deep-cuts-${today}`,
        type: "deep-cuts",
        name: "Deep Cuts",
        description: "Hidden gems waiting to be discovered",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("rediscover"),
    };
}

/**
 * "Key Journey" - Tracks ordered by circle-of-fifths key progression.
 */
export async function generateKeyJourney(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    if (await isJellyfinMusicSource()) {
        return jfVibe.generateKeyJourneyJellyfin(today);
    }
    const keyOrder = [
        "C",
        "G",
        "D",
        "A",
        "E",
        "B",
        "F#",
        "Db",
        "Ab",
        "Eb",
        "Bb",
        "F",
    ];

    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            key: { not: null },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 200,
    });

    if (tracks.length < 15) return null;

    const byKey = new Map<string, typeof tracks>();
    for (const track of tracks) {
        const key = track.key || "C";
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(track);
    }

    const journey: typeof tracks = [];
    const seed = getSeededRandom(`key-journey-${today}`);
    let seedVal = seed;

    for (const key of keyOrder) {
        const keyTracks = byKey.get(key) || [];
        if (keyTracks.length > 0 && journey.length < WEEKLY_TRACK_LIMIT) {
            const count = Math.min(
                2,
                keyTracks.length,
                WEEKLY_TRACK_LIMIT - journey.length
            );
            seedVal = (seedVal * 9301 + 49297) % 233280;
            const shuffled = keyTracks.sort(() => {
                seedVal = (seedVal * 9301 + 49297) % 233280;
                return seedVal / 233280 - 0.5;
            });
            journey.push(...shuffled.slice(0, count));
        }
    }

    if (journey.length < 15) return null;

    const coverUrls = journey
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `key-journey-${today}`,
        type: "key-journey",
        name: "Key Journey",
        description: "Harmonic progression through your library",
        trackIds: journey.map((t) => t.id),
        coverUrls,
        trackCount: journey.length,
        color: getMixColor("instrumental"),
    };
}

/**
 * "Tempo Flow" - An energy arc through BPM: slow → fast → slow.
 */
export async function generateTempoFlow(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    if (await isJellyfinMusicSource()) {
        return jfVibe.generateTempoFlowJellyfin(today);
    }
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            bpm: { not: null },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 200,
    });

    if (tracks.length < 15) return null;

    const sorted = [...tracks].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));

    const slow = sorted.filter((t) => (t.bpm || 0) < 100);
    const medium = sorted.filter(
        (t) => (t.bpm || 0) >= 100 && (t.bpm || 0) < 130
    );
    const fast = sorted.filter((t) => (t.bpm || 0) >= 130);

    const flow: typeof tracks = [];

    flow.push(...randomSample(slow, Math.min(4, slow.length)));
    flow.push(...randomSample(medium, Math.min(5, medium.length)));
    flow.push(...randomSample(fast, Math.min(6, fast.length)));
    flow.push(
        ...randomSample(
            medium.filter((t) => !flow.includes(t)),
            Math.min(3, medium.length)
        )
    );
    flow.push(
        ...randomSample(
            slow.filter((t) => !flow.includes(t)),
            Math.min(2, slow.length)
        )
    );

    if (flow.length < 15) return null;

    const coverUrls = flow
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `tempo-flow-${today}`,
        type: "tempo-flow",
        name: "Tempo Flow",
        description: "An energy journey through BPM",
        trackIds: flow.slice(0, WEEKLY_TRACK_LIMIT).map((t) => t.id),
        coverUrls,
        trackCount: Math.min(flow.length, WEEKLY_TRACK_LIMIT),
        color: getMixColor("workout"),
    };
}

/**
 * "Vocal Detox" - Pure instrumental escape.
 */
export async function generateVocalDetox(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    if (await isJellyfinMusicSource()) {
        return jfVibe.generateVocalDetoxJellyfin(today);
    }
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            instrumentalness: { gte: 0.75 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const shuffled = randomSample(tracks, WEEKLY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `vocal-detox-${today}`,
        type: "vocal-detox",
        name: "Vocal Detox",
        description: "Pure instrumental escape",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("instrumental"),
    };
}

/**
 * "Minor Key Mondays" - All minor key bangers.
 * Only available on Mondays.
 */
export async function generateMinorKeyMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    const dayOfWeek = new Date().getDay();
    if (dayOfWeek !== 1) return null;

    if (await isJellyfinMusicSource()) {
        return jfVibe.generateMinorKeyMixJellyfin(today);
    }

    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            keyScale: "minor",
            energy: { gte: 0.45 },
        },
        include: { album: { select: { coverUrl: true } } },
        take: 100,
    });

    if (tracks.length < 15) return null;

    const shuffled = randomSample(tracks, WEEKLY_TRACK_LIMIT);
    const coverUrls = shuffled
        .filter((t) => t.album.coverUrl)
        .slice(0, 4)
        .map((t) => t.album.coverUrl!);

    return {
        id: `minor-key-${today}`,
        type: "melancholy",
        name: "Minor Key Mondays",
        description: "All minor key bangers",
        trackIds: shuffled.map((t) => t.id),
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor("melancholy"),
    };
}
