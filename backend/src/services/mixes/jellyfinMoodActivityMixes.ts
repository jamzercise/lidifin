/**
 * Arch-X.b.3 — Programmatic mixes from `JellyfinTrackAnalysis` + metadata
 * when Jellyfin is the music source (no local `Track` mirror).
 */

import { prisma } from "@/utils/db";
import { logger } from "@/utils/logger";
import {
    buildJellyfinChillStyleMix,
    buildJellyfinProgrammaticMix,
    jellyfinAnalysisIds,
    jellyfinMetadataIdsByGenrePatterns,
    jellyfinMetadataIdsByLastfmTags,
    mergeUniqueTrackIds,
} from "./jellyfinAnalysisMixHelpers";
import type { ProgrammaticMix } from "./types";

const MOOD_TAG_SAD = [
    "sad",
    "melancholic",
    "melancholy",
    "moody",
    "atmospheric",
];

export async function generateHappyMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                analysisMode: "enhanced",
                moodHappy: { gte: 0.6 },
                moodSad: { lte: 0.3 },
            },
            120
        ),
        await jellyfinAnalysisIds(
            {
                valence: { gte: 0.6 },
                energy: { gte: 0.5 },
            },
            120
        )
    );
    if (ids.length < 15) {
        ids = mergeUniqueTrackIds(
            ids,
            await jellyfinMetadataIdsByGenrePatterns(
                ["pop", "funk", "disco", "soul", "reggae", "ska", "motown"],
                120
            )
        );
    }
    return buildJellyfinProgrammaticMix({
        id: `happy-${today}`,
        type: "happy",
        name: "Happy Vibes",
        description: "Feel-good tracks to brighten your day",
        candidateIds: ids,
        today,
        mixSeedSuffix: "happy",
        colorKey: "happy",
    });
}

export async function generateMelancholyMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let analyses = await prisma.jellyfinTrackAnalysis.findMany({
        where: {
            analysisStatus: "completed",
            analysisMode: "enhanced",
            moodSad: { gte: 0.5 },
            moodHappy: { lte: 0.4 },
        },
        take: 160,
    });

    if (analyses.length < 15) {
        analyses = await prisma.jellyfinTrackAnalysis.findMany({
            where: {
                analysisStatus: "completed",
                valence: { lte: 0.35 },
                energy: { lte: 0.6 },
            },
            take: 160,
        });
        const meta = await prisma.jellyfinTrackMetadata.findMany({
            where: {
                jellyfinId: {
                    in: analyses.map((a) => a.jellyfinTrackId),
                },
            },
            select: { jellyfinId: true, lastfmTags: true },
        });
        const metaMap = new Map(meta.map((m) => [m.jellyfinId, m.lastfmTags]));
        analyses = analyses.filter((t) => {
            const hasMinorKey = t.keyScale === "minor";
            const hasSadTags = (t.moodTags ?? []).some((tag: string) =>
                MOOD_TAG_SAD.includes(tag.toLowerCase())
            );
            const lf = (metaMap.get(t.jellyfinTrackId) ?? []).map((x) =>
                x.toLowerCase()
            );
            const hasLastfmSadTags = lf.some((tag) =>
                [
                    "sad",
                    "melancholic",
                    "melancholy",
                    "depressing",
                    "emotional",
                    "heartbreak",
                ].includes(tag)
            );
            return hasMinorKey || hasSadTags || hasLastfmSadTags;
        });
    }

    let ids = analyses.map((a) => a.jellyfinTrackId);
    if (ids.length < 15) {
        ids = mergeUniqueTrackIds(
            ids,
            await jellyfinMetadataIdsByGenrePatterns(
                [
                    "blues",
                    "soul",
                    "ballad",
                    "singer-songwriter",
                    "slowcore",
                    "sadcore",
                ],
                100
            )
        );
    }

    if (ids.length < 15) {
        logger.debug(
            `[MELANCHOLY MIX] Jellyfin FAILED: Only ${ids.length} tracks`
        );
        return null;
    }

    return buildJellyfinProgrammaticMix({
        id: `melancholy-${today}`,
        type: "melancholy",
        name: "Melancholy",
        description: "Introspective tracks for reflective moments",
        candidateIds: ids,
        today,
        mixSeedSuffix: "melancholy",
        colorKey: "melancholy",
    });
}

export async function generateDanceFloorMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = await jellyfinAnalysisIds(
        {
            danceability: { gte: 0.7 },
            bpm: { gte: 110, lte: 140 },
        },
        120
    );
    if (ids.length < 15) {
        ids = mergeUniqueTrackIds(
            ids,
            await jellyfinMetadataIdsByGenrePatterns(
                [
                    "dance",
                    "electronic",
                    "edm",
                    "house",
                    "disco",
                    "techno",
                    "pop",
                ],
                120
            )
        );
    }
    return buildJellyfinProgrammaticMix({
        id: `dance-floor-${today}`,
        type: "dance-floor",
        name: "Dance Floor",
        description: "High danceability tracks with perfect tempo",
        candidateIds: ids,
        today,
        mixSeedSuffix: "dance-floor",
        colorKey: "dance-floor",
    });
}

export async function generateAcousticMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = await jellyfinAnalysisIds(
        {
            acousticness: { gte: 0.6 },
            energy: { gte: 0.3, lte: 0.6 },
        },
        120
    );
    if (ids.length < 15) {
        ids = mergeUniqueTrackIds(
            ids,
            await jellyfinMetadataIdsByGenrePatterns(
                ["acoustic", "folk", "singer-songwriter", "unplugged", "indie folk"],
                120
            )
        );
    }
    return buildJellyfinProgrammaticMix({
        id: `acoustic-${today}`,
        type: "acoustic",
        name: "Acoustic Afternoon",
        description: "Stripped-down, organic sounds",
        candidateIds: ids,
        today,
        mixSeedSuffix: "acoustic",
        colorKey: "acoustic",
    });
}

export async function generateInstrumentalMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = await jellyfinAnalysisIds(
        {
            instrumentalness: { gte: 0.7 },
            energy: { gte: 0.3, lte: 0.6 },
        },
        120
    );
    if (ids.length < 15) {
        ids = mergeUniqueTrackIds(
            ids,
            await jellyfinMetadataIdsByGenrePatterns(
                [
                    "instrumental",
                    "classical",
                    "soundtrack",
                    "score",
                    "ambient",
                    "post-rock",
                ],
                120
            )
        );
    }
    return buildJellyfinProgrammaticMix({
        id: `instrumental-${today}`,
        type: "instrumental",
        name: "Instrumental Focus",
        description: "No vocals, pure concentration",
        candidateIds: ids,
        today,
        mixSeedSuffix: "instrumental",
        colorKey: "instrumental",
    });
}

export async function generateRoadTripMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = mergeUniqueTrackIds(
        await jellyfinMetadataIdsByLastfmTags(
            ["driving", "road trip", "travel", "summer"],
            100
        ),
        await jellyfinAnalysisIds(
            { moodTags: { hasSome: ["energetic", "upbeat", "happy"] } },
            100
        )
    );
    if (ids.length < 15) {
        ids = mergeUniqueTrackIds(
            ids,
            await jellyfinAnalysisIds(
                {
                    energy: { gte: 0.5, lte: 0.8 },
                    bpm: { gte: 100, lte: 130 },
                },
                100
            )
        );
    }
    if (ids.length < 15) {
        ids = mergeUniqueTrackIds(
            ids,
            await jellyfinMetadataIdsByGenrePatterns(
                ["rock", "pop", "indie", "alternative", "classic rock"],
                120
            )
        );
    }
    return buildJellyfinProgrammaticMix({
        id: `road-trip-${today}`,
        type: "road-trip",
        name: "Road Trip",
        description: "Perfect soundtrack for the open road",
        candidateIds: ids,
        today,
        mixSeedSuffix: "road-trip",
        colorKey: "road-trip",
    });
}

export async function generatePartyMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = mergeUniqueTrackIds(
        await jellyfinMetadataIdsByGenrePatterns(
            [
                "dance",
                "electronic",
                "pop",
                "disco",
                "house",
                "techno",
                "edm",
                "funk",
                "electro",
                "club",
            ],
            150
        ),
        await jellyfinAnalysisIds(
            {
                OR: [
                    { danceability: { gte: 0.7 } },
                    {
                        AND: [{ energy: { gte: 0.7 } }, { bpm: { gte: 110 } }],
                    },
                ],
            },
            80
        )
    );
    return buildJellyfinProgrammaticMix({
        id: `party-${today}`,
        type: "dance-floor",
        name: "Party Playlist",
        description: "High energy dance, EDM, and pop hits",
        candidateIds: ids,
        today,
        mixSeedSuffix: "party",
        colorKey: "dance-floor",
    });
}

export async function generateChillMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                analysisMode: "enhanced",
                AND: [
                    { moodRelaxed: { gte: 0.5 } },
                    { moodAggressive: { lte: 0.3 } },
                    { energy: { lte: 0.55 } },
                ],
            },
            120
        ),
        await jellyfinAnalysisIds(
            {
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
            120
        )
    );
    return buildJellyfinChillStyleMix({
        id: `chill-${today}`,
        type: "chill",
        name: "Chill Mix",
        description: "Relax and unwind with mellow vibes",
        candidateIds: ids,
        today,
        mixSeedSuffix: "chill",
        colorKey: "chill",
    });
}

export async function generateWorkoutMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                analysisMode: "enhanced",
                AND: [
                    { arousal: { gte: 0.6 } },
                    { energy: { gte: 0.6 } },
                    { bpm: { gte: 110 } },
                    { moodRelaxed: { lte: 0.4 } },
                ],
            },
            100
        ),
        await jellyfinAnalysisIds(
            {
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
            100
        ),
        await jellyfinMetadataIdsByGenrePatterns(
            [
                "rock",
                "metal",
                "hip hop",
                "electronic",
                "edm",
                "pop punk",
            ],
            120
        )
    );
    return buildJellyfinProgrammaticMix({
        id: `workout-${today}`,
        type: "workout",
        name: "Workout Mix",
        description: "High energy tracks to power your workout",
        candidateIds: ids,
        today,
        mixSeedSuffix: "workout",
        colorKey: "workout",
    });
}

export async function generateFocusMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = mergeUniqueTrackIds(
        await jellyfinMetadataIdsByGenrePatterns(
            [
                "classical",
                "instrumental",
                "jazz",
                "piano",
                "ambient",
                "soundtrack",
                "score",
            ],
            150
        ),
        await jellyfinAnalysisIds(
            {
                instrumentalness: { gte: 0.5 },
                energy: { gte: 0.2, lte: 0.7 },
            },
            80
        )
    );
    return buildJellyfinProgrammaticMix({
        id: `focus-${today}`,
        type: "focus-flow",
        name: "Focus Mix",
        description: "Concentration music for deep work",
        candidateIds: ids,
        today,
        mixSeedSuffix: "focus",
        colorKey: "focus-flow",
    });
}

export async function generateHighEnergyMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = await jellyfinAnalysisIds(
        {
            energy: { gte: 0.7 },
            bpm: { gte: 120 },
        },
        120
    );
    if (ids.length < 15) {
        ids = mergeUniqueTrackIds(
            ids,
            await jellyfinMetadataIdsByGenrePatterns(
                ["rock", "metal", "punk", "electronic", "edm", "hip hop"],
                120
            )
        );
    }
    return buildJellyfinProgrammaticMix({
        id: `high-energy-${today}`,
        type: "workout",
        name: "High Energy",
        description: "Fast-paced tracks to get you moving",
        candidateIds: ids,
        today,
        mixSeedSuffix: "high-energy",
        colorKey: "workout",
    });
}

export async function generateLateNightMixJellyfin(
    today: string
): Promise<ProgrammaticMix | null> {
    let ids = mergeUniqueTrackIds(
        await jellyfinAnalysisIds(
            {
                analysisMode: "enhanced",
                AND: [
                    { moodRelaxed: { gte: 0.5 } },
                    { moodAggressive: { lte: 0.4 } },
                    { energy: { lte: 0.5 } },
                    { bpm: { lte: 110 } },
                ],
            },
            120
        ),
        await jellyfinAnalysisIds(
            {
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
            120
        )
    );
    return buildJellyfinChillStyleMix({
        id: `late-night-${today}`,
        type: "late-night",
        name: "Late Night",
        description: "Mellow vibes for the quiet hours",
        candidateIds: ids,
        today,
        mixSeedSuffix: "late-night",
        colorKey: "late-night",
    });
}
