/**
 * Arch-X.b.3 — Vibe / day / advanced weekly mixes from Jellyfin analysis.
 */

import { prisma } from "@/utils/db";
import { resolveTrackReferences } from "@/services/jellyfin";
import { getMixColor } from "./colors";
import {
    MIN_TRACKS_DAILY,
    TRACK_LIMIT,
    WEEKLY_TRACK_LIMIT,
} from "./constants";
import {
    buildJellyfinDailyVibeMix,
    buildJellyfinProgrammaticMix,
    buildJellyfinWeeklyPoolMix,
    jellyfinAnalysisIds,
    jellyfinMetadataIdsByLastfmTags,
    mergeUniqueTrackIds,
} from "./jellyfinAnalysisMixHelpers";
import { getSeededRandom, randomSample } from "./helpers";
import type { ProgrammaticMix } from "./types";

export async function generateSadGirlSundaysJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
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
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["sad", "melancholic", "heartbreak", "emotional"],
            80
        )
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `sad-girl-sundays-${today}`,
        type: "sad-girl-sundays",
        name: "Sad Girl Sundays",
        description: "Melancholic introspection and feelings",
        colorKey: "sad-girl-sundays",
    });
}

export async function generateMainCharacterEnergyJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                OR: [
                    {
                        AND: [
                            { valence: { gte: 0.55 } },
                            { energy: { gte: 0.55 } },
                            { danceability: { gte: 0.5 } },
                        ],
                    },
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["empowering", "confident", "uplifting", "anthemic"],
            80
        )
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `main-character-${today}`,
        type: "main-character",
        name: "Main Character Energy",
        description: "You're the protagonist today",
        colorKey: "main-character",
    });
}

export async function generateVillainEraJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                OR: [
                    {
                        AND: [{ keyScale: "minor" }, { energy: { gte: 0.65 } }],
                    },
                    {
                        moodTags: {
                            hasSome: ["aggressive", "dark", "intense"],
                        },
                    },
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["dark", "aggressive", "intense", "powerful"],
            80
        )
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `villain-era-${today}`,
        type: "villain-era",
        name: "Villain Era",
        description: "Embrace your dark side",
        colorKey: "villain-era",
    });
}

export async function generate3AMThoughtsJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        {
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
        80
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        minPool: MIN_TRACKS_DAILY,
        today,
        id: `3am-thoughts-${today}`,
        type: "3am-thoughts",
        name: "3AM Thoughts",
        description: "Late night overthinking companion",
        colorKey: "3am-thoughts",
    });
}

export async function generateHotGirlWalkJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        {
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
        80
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `hot-girl-walk-${today}`,
        type: "hot-girl-walk",
        name: "Hot Girl Walk",
        description: "Confidence boost for your walk",
        colorKey: "confidence-boost",
    });
}

export async function generateRageCleaningJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
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
                    { moodTags: { hasSome: ["aggressive", "energetic"] } },
                ],
            },
            80
        )
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `rage-cleaning-${today}`,
        type: "rage-cleaning",
        name: "Rage Cleaning",
        description: "Aggressive productivity fuel",
        colorKey: "workout",
    });
}

export async function generateGoldenHourJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                OR: [
                    {
                        AND: [
                            { valence: { gte: 0.45 } },
                            { acousticness: { gte: 0.35 } },
                            { energy: { gte: 0.25, lte: 0.65 } },
                        ],
                    },
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["warm", "sunset", "dreamy", "peaceful"],
            80
        )
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `golden-hour-${today}`,
        type: "golden-hour",
        name: "Golden Hour",
        description: "Warm sunset vibes",
        colorKey: "golden-hour",
    });
}

export async function generateShowerKaraokeJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        {
            AND: [
                { instrumentalness: { lte: 0.35 } },
                { energy: { gte: 0.55 } },
                { valence: { gte: 0.45 } },
            ],
        },
        80
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `shower-karaoke-${today}`,
        type: "shower-karaoke",
        name: "Shower Karaoke",
        description: "Belters you can't help but sing",
        colorKey: "happy",
    });
}

export async function generateInMyFeelingsJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                OR: [
                    {
                        AND: [
                            { valence: { lte: 0.4 } },
                            { arousal: { lte: 0.55 } },
                            { acousticness: { gte: 0.25 } },
                        ],
                    },
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["emotional", "heartbreak", "feelings", "vulnerable"],
            80
        )
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `in-my-feelings-${today}`,
        type: "in-my-feelings",
        name: "In My Feelings",
        description: "Let it all out",
        colorKey: "heartbreak-hotel",
    });
}

export async function generateMidnightDriveJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        {
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
        80
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        minPool: MIN_TRACKS_DAILY,
        today,
        id: `midnight-drive-${today}`,
        type: "midnight-drive",
        name: "Midnight Drive",
        description: "Perfect for late night cruising",
        colorKey: "night-drive",
    });
}

export async function generateCoffeeShopVibesJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        {
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
        80
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        minPool: MIN_TRACKS_DAILY,
        today,
        id: `coffee-shop-${today}`,
        type: "coffee-shop",
        name: "Coffee Shop Vibes",
        description: "Cozy background music",
        colorKey: "coffee-shop",
    });
}

export async function generateRomanticizeYourLifeJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                OR: [
                    {
                        AND: [
                            { valence: { gte: 0.35, lte: 0.75 } },
                            { arousal: { gte: 0.25, lte: 0.65 } },
                            { acousticness: { gte: 0.25 } },
                        ],
                    },
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["dreamy", "aesthetic", "cinematic", "romantic"],
            80
        )
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `romanticize-${today}`,
        type: "romanticize",
        name: "Romanticize Your Life",
        description: "Make every moment aesthetic",
        colorKey: "golden-hour",
    });
}

export async function generateThatGirlEraJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        {
            AND: [
                { valence: { gte: 0.55 } },
                { energy: { gte: 0.45 } },
                { danceability: { gte: 0.45 } },
            ],
        },
        80
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `that-girl-era-${today}`,
        type: "that-girl-era",
        name: "That Girl Era",
        description: "Self-improvement mode activated",
        colorKey: "confidence-boost",
    });
}

export async function generateUnhingedJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        {
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
        120
    );
    return buildJellyfinDailyVibeMix({
        candidateIds: ids,
        today,
        id: `unhinged-${today}`,
        type: "unhinged",
        name: "Unhinged",
        description: "Embrace the chaos",
        colorKey: "dance-floor",
    });
}

export async function generateSundayMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                AND: [
                    { energy: { lte: 0.5 } },
                    { acousticness: { gte: 0.5 } },
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["relaxed", "calm", "peaceful", "chill", "sunday"],
            100
        )
    );
    return buildJellyfinProgrammaticMix({
        id: `sunday-${today}`,
        type: "sunday-morning",
        name: "Sunday Morning",
        description: "Peaceful tunes for a lazy Sunday",
        candidateIds: ids,
        today,
        mixSeedSuffix: "sunday",
        colorKey: "sunday-morning",
        trackLimit: TRACK_LIMIT,
    });
}

export async function generateMondayMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                AND: [
                    { energy: { gte: 0.6 } },
                    { valence: { gte: 0.5 } },
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["motivation", "uplifting", "energetic", "happy"],
            100
        )
    );
    return buildJellyfinProgrammaticMix({
        id: `monday-${today}`,
        type: "confidence-boost",
        name: "Monday Motivation",
        description: "Start your week with energy",
        candidateIds: ids,
        today,
        mixSeedSuffix: "monday",
        colorKey: "confidence-boost",
        trackLimit: TRACK_LIMIT,
    });
}

export async function generateFridayMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                AND: [
                    { danceability: { gte: 0.7 } },
                    { energy: { gte: 0.6 } },
                ],
            },
            80
        ),
        await jellyfinMetadataIdsByLastfmTags(
            ["party", "dance", "fun", "groovy"],
            100
        )
    );
    return buildJellyfinProgrammaticMix({
        id: `friday-${today}`,
        type: "dance-floor",
        name: "Friday Night",
        description: "Weekend vibes to kick off the party",
        candidateIds: ids,
        today,
        mixSeedSuffix: "friday",
        colorKey: "dance-floor",
        trackLimit: TRACK_LIMIT,
    });
}

export async function generateKeyJourneyJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
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
    const analyses = await prisma.jellyfinTrackAnalysis.findMany({
        where: {
            analysisStatus: "completed",
            key: { not: null },
        },
        take: 300,
    });
    if (analyses.length < 15) return null;

    const byKey = new Map<string, typeof analyses>();
    for (const track of analyses) {
        const key = track.key || "C";
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key)!.push(track);
    }

    const journey: typeof analyses = [];
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

    const trackIds = journey.map((t) => t.jellyfinTrackId);
    const resolved = await resolveTrackReferences(trackIds);
    const coverUrls = resolved
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => t.album.coverArt)
        .filter((u): u is string => !!u)
        .slice(0, 4);

    return {
        id: `key-journey-${today}`,
        type: "key-journey",
        name: "Key Journey",
        description: "Harmonic progression through your library",
        trackIds,
        coverUrls,
        trackCount: journey.length,
        color: getMixColor("instrumental"),
    };
}

export async function generateTempoFlowJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const analyses = await prisma.jellyfinTrackAnalysis.findMany({
        where: { analysisStatus: "completed", bpm: { not: null } },
        take: 250,
    });
    if (analyses.length < 15) return null;

    const sorted = [...analyses].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));
    const slow = sorted.filter((t) => (t.bpm || 0) < 100);
    const medium = sorted.filter(
        (t) => (t.bpm || 0) >= 100 && (t.bpm || 0) < 130
    );
    const fast = sorted.filter((t) => (t.bpm || 0) >= 130);

    const flow: typeof analyses = [];
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

    const slice = flow.slice(0, WEEKLY_TRACK_LIMIT);
    const trackIds = slice.map((t) => t.jellyfinTrackId);
    const resolved = await resolveTrackReferences(trackIds);
    const coverUrls = resolved
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => t.album.coverArt)
        .filter((u): u is string => !!u)
        .slice(0, 4);

    return {
        id: `tempo-flow-${today}`,
        type: "tempo-flow",
        name: "Tempo Flow",
        description: "An energy journey through BPM",
        trackIds,
        coverUrls,
        trackCount: slice.length,
        color: getMixColor("workout"),
    };
}

export async function generateVocalDetoxJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        { instrumentalness: { gte: 0.75 } },
        120
    );
    return buildJellyfinWeeklyPoolMix({
        candidateIds: ids,
        today,
        id: `vocal-detox-${today}`,
        type: "vocal-detox",
        name: "Vocal Detox",
        description: "Pure instrumental escape",
        colorKey: "instrumental",
    });
}

export async function generateMinorKeyMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const ids = await jellyfinAnalysisIds(
        {
            keyScale: "minor",
            energy: { gte: 0.45 },
        },
        120
    );
    return buildJellyfinWeeklyPoolMix({
        candidateIds: ids,
        today,
        id: `minor-key-${today}`,
        type: "melancholy",
        name: "Minor Key Mondays",
        description: "All minor key bangers",
        colorKey: "melancholy",
    });
}

/**
 * Deep Cuts — Jellyfin library tracks with no `Play` rows, then fallback to
 * `jellyfin:` tracks with ≤3 plays (matches native `generateDeepCuts` semantics;
 * `Play` is not scoped per user).
 */
export async function generateDeepCutsJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    const unplayedRows = await prisma.$queryRaw<{ jellyfinId: string }[]>`
        SELECT j."jellyfinId"
        FROM "JellyfinTrackMetadata" j
        LEFT JOIN "Play" p ON p."trackId" = j."jellyfinId"
        WHERE p.id IS NULL
        LIMIT 200
    `;
    const unplayedIds = unplayedRows.map((r) => r.jellyfinId);

    const buildReturn = async (trackIds: string[]) => {
        const shuffled = randomSample(trackIds, WEEKLY_TRACK_LIMIT);
        const resolved = await resolveTrackReferences(shuffled);
        const coverUrls = resolved
            .filter((t): t is NonNullable<typeof t> => t !== null)
            .map((t) => t.album.coverArt)
            .filter((u): u is string => !!u)
            .slice(0, 4);
        return {
            id: `deep-cuts-${today}`,
            type: "deep-cuts" as const,
            name: "Deep Cuts",
            description: "Hidden gems waiting to be discovered",
            trackIds: shuffled,
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor("rediscover"),
        };
    };

    if (unplayedIds.length < 15) {
        const playCounts = await prisma.$queryRaw<
            { trackId: string; c: number }[]
        >`
            SELECT "trackId", COUNT(*)::int as c FROM "Play"
            WHERE "trackId" LIKE 'jellyfin:%'
            GROUP BY "trackId"
            HAVING COUNT(*) <= 3
        `;
        const lowPlayIds = [...new Set(playCounts.map((r) => r.trackId))];
        const inMeta = await prisma.jellyfinTrackMetadata.findMany({
            where: { jellyfinId: { in: lowPlayIds } },
            select: { jellyfinId: true },
            take: 200,
        });
        const pool = inMeta.map((m) => m.jellyfinId);
        if (pool.length < 15) return null;
        return buildReturn(pool);
    }

    return buildReturn(unplayedIds);
}
