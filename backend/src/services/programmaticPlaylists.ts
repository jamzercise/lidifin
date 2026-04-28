import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { normalizeArtistName } from "../utils/artistNormalization";
import { lastFmService } from "./lastfm";
import { moodBucketService } from "./moodBucketService";
import {
    getDecadeWhereClause,
    getEffectiveYear,
    getDecadeFromYear,
} from "../utils/dateFilters";
import {
    DAILY_MIX_COUNT,
    DAILY_TRACK_LIMIT,
    MIN_TRACKS_DAILY,
    MIN_TRACKS_WEEKLY,
    TRACK_LIMIT,
    WEEKLY_TRACK_LIMIT,
} from "./mixes/constants";
import { getMixColor } from "./mixes/colors";
import {
    findTracksByGenrePatterns,
    getSeededRandom,
    randomSample,
} from "./mixes/helpers";
import type {
    ProgrammaticMix,
    TrackWithAlbumCover,
} from "./mixes/types";
import {
    generateArtistSimilarMix,
    generateEraMix,
    generateGenreMix,
    generateRandomDiscoveryMix,
    generateRediscoverMix,
    generateTopTracksMix,
} from "./mixes/generators/core";
import {
    generateChillMix,
    generateFocusMix,
    generateHighEnergyMix,
    generateLateNightMix,
    generatePartyMix,
    generateWorkoutMix,
} from "./mixes/generators/activity";
import {
    generateAcousticMix,
    generateDanceFloorMix,
    generateHappyMix,
    generateInstrumentalMix,
    generateMelancholyMix,
    generateRoadTripMix,
} from "./mixes/generators/mood";
import {
    generateJellyfinArtistDeepDiveMix,
    generateJellyfinDeepCutsMix,
    generateJellyfinDiscoveryMix,
    generateJellyfinGenreMix,
    generateJellyfinMoodMix,
    generateJellyfinRecentlyAddedMix,
} from "./mixes/generators/jellyfin";

export type { ProgrammaticMix } from "./mixes/types";

export class ProgrammaticPlaylistService {
    /**
     * Generate 4 daily rotating mixes
     */
    async generateAllMixes(
        userId: string,
        forceRandom = false
    ): Promise<ProgrammaticMix[]> {
        // Get today's date for daily rotation (or random seed if refreshing)
        const today = new Date().toISOString().split("T")[0];
        const seedString = forceRandom
            ? `${userId}-${Date.now()}-${Math.random()}`
            : `${today}-${userId}`;
        const dateSeed = getSeededRandom(seedString);

        logger.debug(
            `[MIXES] Generating mixes for user ${userId}, forceRandom: ${forceRandom}, seed: ${dateSeed}`
        );

        // Define all possible mix types
        const seedSuffix = forceRandom ? `-${Date.now()}` : "";
        const mixGenerators = [
            // Classic mixes (genre/era based)
            {
                fn: () => generateEraMix(userId, today + seedSuffix),
                weight: 2,
                name: "Era Mix",
            },
            {
                fn: () => generateGenreMix(userId, today + seedSuffix),
                weight: 2,
                name: "Genre Mix",
            },
            {
                fn: () => generateTopTracksMix(userId),
                weight: 1,
                name: "Top Tracks Mix",
            },
            {
                fn: () => generateRediscoverMix(userId, today + seedSuffix),
                weight: 1,
                name: "Rediscover Mix",
            },
            {
                fn: () => generateArtistSimilarMix(userId),
                weight: 1,
                name: "Artist Similar Mix",
            },
            {
                fn: () =>
                    generateRandomDiscoveryMix(userId, today + seedSuffix),
                weight: 1,
                name: "Random Discovery Mix",
            },
            // Jellyfin-only mixes (return null when native library)
            {
                fn: () => generateJellyfinGenreMix(today + seedSuffix),
                weight: 3,
                name: "Jellyfin Genre Mix",
                jellyfinOnly: true,
            },
            {
                fn: () => generateJellyfinDiscoveryMix(today + seedSuffix),
                weight: 3,
                name: "Jellyfin Discovery Mix",
                jellyfinOnly: true,
            },
            {
                fn: () => generateJellyfinMoodMix(today + seedSuffix),
                weight: 3,
                name: "Jellyfin Mood Mix",
                jellyfinOnly: true,
            },
            {
                fn: () =>
                    generateJellyfinDeepCutsMix(userId, today + seedSuffix),
                weight: 3,
                name: "Jellyfin Deep Cuts",
                jellyfinOnly: true,
            },
            {
                fn: () =>
                    generateJellyfinRecentlyAddedMix(today + seedSuffix),
                weight: 3,
                name: "Jellyfin Recently Added",
                jellyfinOnly: true,
            },
            {
                fn: () =>
                    generateJellyfinArtistDeepDiveMix(
                        userId,
                        today + seedSuffix
                    ),
                weight: 3,
                name: "Jellyfin Artist Deep Dive",
                jellyfinOnly: true,
            },
            {
                fn: () => generatePartyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Party Mix",
            },
            {
                fn: () => generateChillMix(userId, today + seedSuffix),
                weight: 2,
                name: "Chill Mix",
            },
            {
                fn: () => generateWorkoutMix(userId, today + seedSuffix),
                weight: 2,
                name: "Workout Mix",
            },
            {
                fn: () => generateFocusMix(userId, today + seedSuffix),
                weight: 2,
                name: "Focus Mix",
            },
            // Audio analysis-based mixes (using Essentia features)
            {
                fn: () => generateHighEnergyMix(userId, today + seedSuffix),
                weight: 2,
                name: "High Energy Mix",
            },
            {
                fn: () => generateLateNightMix(userId, today + seedSuffix),
                weight: 2,
                name: "Late Night Mix",
            },
            {
                fn: () => generateHappyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Happy Vibes Mix",
            },
            {
                fn: () => generateMelancholyMix(userId, today + seedSuffix),
                weight: 2,
                name: "Melancholy Mix",
            },
            {
                fn: () => generateDanceFloorMix(userId, today + seedSuffix),
                weight: 2,
                name: "Dance Floor Mix",
            },
            {
                fn: () => generateAcousticMix(userId, today + seedSuffix),
                weight: 2,
                name: "Acoustic Mix",
            },
            {
                fn: () => generateInstrumentalMix(userId, today + seedSuffix),
                weight: 2,
                name: "Instrumental Mix",
            },
            {
                fn: () => generateRoadTripMix(userId, today + seedSuffix),
                weight: 2,
                name: "Road Trip Mix",
            },
            // Day-of-week mixes
            {
                fn: () => this.generateDayMix(userId),
                weight: 1,
                name: "Day Mix",
            },
            // Curated Vibe Mixes (Daily, 10 tracks)
            {
                fn: () =>
                    this.generateSadGirlSundays(userId, today + seedSuffix),
                weight: 2,
                name: "Sad Girl Sundays",
            },
            {
                fn: () =>
                    this.generateMainCharacterEnergy(
                        userId,
                        today + seedSuffix
                    ),
                weight: 2,
                name: "Main Character Energy",
            },
            {
                fn: () => this.generateVillainEra(userId, today + seedSuffix),
                weight: 2,
                name: "Villain Era",
            },
            {
                fn: () => this.generate3AMThoughts(userId, today + seedSuffix),
                weight: 2,
                name: "3AM Thoughts",
            },
            {
                fn: () => this.generateHotGirlWalk(userId, today + seedSuffix),
                weight: 2,
                name: "Hot Girl Walk",
            },
            {
                fn: () => this.generateRageCleaning(userId, today + seedSuffix),
                weight: 2,
                name: "Rage Cleaning",
            },
            {
                fn: () => this.generateGoldenHour(userId, today + seedSuffix),
                weight: 2,
                name: "Golden Hour",
            },
            {
                fn: () =>
                    this.generateShowerKaraoke(userId, today + seedSuffix),
                weight: 2,
                name: "Shower Karaoke",
            },
            {
                fn: () => this.generateInMyFeelings(userId, today + seedSuffix),
                weight: 2,
                name: "In My Feelings",
            },
            {
                fn: () =>
                    this.generateMidnightDrive(userId, today + seedSuffix),
                weight: 2,
                name: "Midnight Drive",
            },
            {
                fn: () =>
                    this.generateCoffeeShopVibes(userId, today + seedSuffix),
                weight: 2,
                name: "Coffee Shop Vibes",
            },
            {
                fn: () =>
                    this.generateRomanticizeYourLife(
                        userId,
                        today + seedSuffix
                    ),
                weight: 2,
                name: "Romanticize Your Life",
            },
            {
                fn: () => this.generateThatGirlEra(userId, today + seedSuffix),
                weight: 2,
                name: "That Girl Era",
            },
            {
                fn: () => this.generateUnhinged(userId, today + seedSuffix),
                weight: 2,
                name: "Unhinged",
            },
            // Weekly Curated Mixes (20 tracks)
            {
                fn: () => this.generateDeepCuts(userId, today + seedSuffix),
                weight: 1,
                name: "Deep Cuts",
            },
            {
                fn: () => this.generateKeyJourney(userId, today + seedSuffix),
                weight: 1,
                name: "Key Journey",
            },
            {
                fn: () => this.generateTempoFlow(userId, today + seedSuffix),
                weight: 1,
                name: "Tempo Flow",
            },
            {
                fn: () => this.generateVocalDetox(userId, today + seedSuffix),
                weight: 1,
                name: "Vocal Detox",
            },
            {
                fn: () => this.generateMinorKeyMix(userId, today + seedSuffix),
                weight: 1,
                name: "Minor Key Mondays",
            },
        ];

        // Select 5 mixes based on date seed, with Jellyfin priority when applicable
        const selectedIndices: number[] = [];
        let seed = dateSeed;

        // When Jellyfin is the primary music source, guarantee 2 Jellyfin slots
        const { isJellyfinMusicSource } = await import("./jellyfin");
        const isJellyfin = await isJellyfinMusicSource();
        const JELLYFIN_RESERVED_SLOTS = isJellyfin ? 2 : 0;

        if (isJellyfin && JELLYFIN_RESERVED_SLOTS > 0) {
            const jellyfinIndices = mixGenerators
                .map((g, i) => ({ index: i, isJellyfin: "jellyfinOnly" in g && (g as any).jellyfinOnly }))
                .filter((g) => g.isJellyfin)
                .map((g) => g.index);

            if (jellyfinIndices.length > 0) {
                // Pick JELLYFIN_RESERVED_SLOTS unique Jellyfin generators using seeded random
                let jfSeed = seed;
                while (
                    selectedIndices.length < JELLYFIN_RESERVED_SLOTS &&
                    selectedIndices.length < jellyfinIndices.length
                ) {
                    jfSeed = (jfSeed * 9301 + 49297) % 233280;
                    const pick = jellyfinIndices[jfSeed % jellyfinIndices.length];
                    if (!selectedIndices.includes(pick)) {
                        selectedIndices.push(pick);
                        logger.debug(
                            `[MIXES] Reserved Jellyfin slot: index ${pick} (${mixGenerators[pick].name})`
                        );
                    }
                }
            }
        }

        logger.debug(
            `[MIXES] Selecting ${DAILY_MIX_COUNT} mixes from ${mixGenerators.length} types (${JELLYFIN_RESERVED_SLOTS} Jellyfin reserved)...`
        );

        // Fill remaining slots from the full pool
        while (selectedIndices.length < DAILY_MIX_COUNT) {
            seed = (seed * 9301 + 49297) % 233280;
            const index = seed % mixGenerators.length;
            if (!selectedIndices.includes(index)) {
                selectedIndices.push(index);
                logger.debug(
                    `[MIXES] Selected index ${index}: ${mixGenerators[index].name}`
                );
            }
        }

        logger.debug(
            `[MIXES] Final selected indices: [${selectedIndices.join(", ")}]`
        );

        // Generate selected mixes
        const mixPromises = selectedIndices.map((i) => {
            logger.debug(`[MIXES] Generating ${mixGenerators[i].name}...`);
            return mixGenerators[i].fn();
        });
        const mixes = await Promise.all(mixPromises);

        logger.debug(`[MIXES] Generated ${mixes.length} mixes before filtering`);
        mixes.forEach((mix, i) => {
            if (mix === null) {
                logger.debug(
                    `[MIXES] Mix ${i} (${
                        mixGenerators[selectedIndices[i]].name
                    }) returned NULL`
                );
            } else {
                logger.debug(
                    `[MIXES] Mix ${i}: ${mix.name} (${mix.trackCount} tracks)`
                );
            }
        });

        // Filter out null mixes
        let finalMixes = mixes.filter(
            (mix): mix is ProgrammaticMix => mix !== null
        );
        logger.debug(
            `[MIXES] Returning ${finalMixes.length} mixes after filtering nulls`
        );

        // If we don't have 5 mixes, try to fill gaps with successful generators
        if (finalMixes.length < DAILY_MIX_COUNT) {
            logger.debug(
                `[MIXES] Only got ${finalMixes.length} mixes, trying to fill gaps...`
            );

            // Try generating from all types that weren't selected or failed
            const successfulTypes = new Set(finalMixes.map((m) => m.type));
            const attemptedIndices = new Set(selectedIndices);

            for (
                let i = 0;
                i < mixGenerators.length &&
                finalMixes.length < DAILY_MIX_COUNT;
                i++
            ) {
                if (!attemptedIndices.has(i)) {
                    logger.debug(
                        `[MIXES] Attempting fallback: ${mixGenerators[i].name}`
                    );
                    const fallbackMix = await mixGenerators[i].fn();
                    if (fallbackMix && !successfulTypes.has(fallbackMix.type)) {
                        finalMixes.push(fallbackMix);
                        successfulTypes.add(fallbackMix.type);
                        logger.debug(
                            `[MIXES] Fallback succeeded: ${fallbackMix.name}`
                        );
                    }
                }
            }

            logger.debug(`[MIXES] After fallbacks: ${finalMixes.length} mixes`);
        }

        // Check if user has saved mood mix from the new bucket system (fast lookup)
        try {
            const savedMoodMix = await moodBucketService.getUserMoodMix(userId);
            if (savedMoodMix) {
                logger.debug(
                    `[MIXES] User has saved mood mix: "${savedMoodMix.name}" with ${savedMoodMix.trackCount} tracks`
                );
                finalMixes.push(savedMoodMix);
            }
        } catch (err) {
            logger.error("[MIXES] Error getting user's saved mood mix:", err);
        }

        return finalMixes;
    }

    // DAY-OF-WEEK MIXES

    /**
     * Generate day-specific mix based on the current day
     */
    async generateDayMix(userId: string): Promise<ProgrammaticMix | null> {
        const dayOfWeek = new Date().getDay();
        const today = new Date().toISOString().split("T")[0];

        // Different vibes for different days
        switch (dayOfWeek) {
            case 0: // Sunday - Relaxed
                return this.generateSundayMix(userId, today);
            case 1: // Monday - Motivation
                return this.generateMondayMix(userId, today);
            case 5: // Friday - Party
                return this.generateFridayMix(userId, today);
            default:
                return null;
        }
    }

    async generateSundayMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: {
                OR: [
                    {
                        analysisStatus: "completed",
                        energy: { lte: 0.5 },
                        acousticness: { gte: 0.5 },
                    },
                    {
                        lastfmTags: {
                            hasSome: [
                                "relaxed",
                                "calm",
                                "peaceful",
                                "chill",
                                "sunday",
                            ],
                        },
                    },
                ],
            },
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = randomSample(tracks, TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `sunday-${today}`,
            type: "sunday-morning",
            name: "Sunday Morning",
            description: "Peaceful tunes for a lazy Sunday",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("sunday-morning"),
        };
    }

    async generateMondayMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: {
                OR: [
                    {
                        analysisStatus: "completed",
                        energy: { gte: 0.6 },
                        valence: { gte: 0.5 },
                    },
                    {
                        lastfmTags: {
                            hasSome: [
                                "motivation",
                                "uplifting",
                                "energetic",
                                "happy",
                            ],
                        },
                    },
                ],
            },
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = randomSample(tracks, TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `monday-${today}`,
            type: "confidence-boost",
            name: "Monday Motivation",
            description: "Start your week with energy",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("confidence-boost"),
        };
    }

    async generateFridayMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: {
                OR: [
                    {
                        analysisStatus: "completed",
                        danceability: { gte: 0.7 },
                        energy: { gte: 0.6 },
                    },
                    {
                        lastfmTags: {
                            hasSome: ["party", "dance", "fun", "groovy"],
                        },
                    },
                ],
            },
            include: {
                album: { select: { coverUrl: true } },
            },
            take: 100,
        });

        if (tracks.length < 15) return null;

        const selectedTracks = randomSample(tracks, TRACK_LIMIT);
        const coverUrls = selectedTracks
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        return {
            id: `friday-${today}`,
            type: "dance-floor",
            name: "Friday Night",
            description: "Weekend vibes to kick off the party",
            trackIds: selectedTracks.map((t) => t.id),
            coverUrls,
            trackCount: selectedTracks.length,
            color: getMixColor("dance-floor"),
        };
    }

    // CURATED VIBE MIXES (Daily, 10 tracks)

    /**
     * "Sad Girl Sundays" - Melancholic introspection
     * valence < 0.3 + keyScale = 'minor' + arousal < 0.4
     * Only available on Sundays
     */
    async generateSadGirlSundays(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Only generate on Sundays (day 0)
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
     * "Main Character Energy" - Walking through life like a movie
     * valence > 0.6 + energy > 0.6 + danceability > 0.5
     */
    async generateMainCharacterEnergy(
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
     * "Villain Era" - Dark, empowering, dramatic
     * keyScale = 'minor' + energy > 0.7 + moodTags includes 'aggressive'
     */
    async generateVillainEra(
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
     * "3AM Thoughts" - Late night overthinking
     * arousal < 0.3 + energy < 0.4 + valence < 0.4
     */
    async generate3AMThoughts(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // STRICT criteria: truly late-night introspective tracks only
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
     * "Hot Girl Walk" - Confident, upbeat cardio
     * danceability > 0.7 + bpm 100-130 + energy > 0.6
     */
    async generateHotGirlWalk(
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
     * "Rage Cleaning" - Aggressive productivity
     * energy > 0.8 + arousal > 0.7 + bpm > 130
     */
    async generateRageCleaning(
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
     * "Golden Hour" - Warm, hopeful, sunset vibes
     * valence > 0.5 + acousticness > 0.4 + energy 0.3-0.6
     */
    async generateGoldenHour(
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
     * "Shower Karaoke" - Belters you can't help but sing
     * instrumentalness < 0.3 + energy > 0.6 + valence > 0.5
     */
    async generateShowerKaraoke(
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
     * "In My Feelings" - Deep emotional processing
     * valence < 0.35 + arousal < 0.5 + acousticness > 0.3
     */
    async generateInMyFeelings(
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
     * "Midnight Drive" - Cruising at night, contemplative
     * energy 0.4-0.6 + arousal 0.3-0.5 + bpm 90-120
     */
    async generateMidnightDrive(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // STRICT criteria: contemplative driving music only
        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                AND: [
                    // MUST be moderate energy (not too mellow, not too intense)
                    { energy: { gte: 0.3, lte: 0.65 } },
                    // MUST have cruising tempo
                    { bpm: { gte: 80, lte: 130 } },
                    // Plus mellow mood indicator
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
     * "Coffee Shop Vibes" - Cozy background energy
     * acousticness > 0.5 + energy 0.2-0.5 + instrumentalness > 0.3
     */
    async generateCoffeeShopVibes(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // STRICT criteria: cozy, background-appropriate music only
        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                AND: [
                    // MUST be low-to-moderate energy
                    { energy: { lte: 0.55 } },
                    // MUST be moderate-slow tempo
                    { bpm: { lte: 120 } },
                    // Plus at least one cozy indicator
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
     * "Romanticize Your Life" - Dreamy, aesthetic moments
     * valence 0.4-0.7 + arousal 0.3-0.6 + acousticness > 0.3
     */
    async generateRomanticizeYourLife(
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
     * "That Girl Era" - Self-improvement anthem energy
     * valence > 0.6 + energy > 0.5 + danceability > 0.5
     */
    async generateThatGirlEra(
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
     * "Unhinged" - Chaotic, weird, fun
     * High variance in features, unexpected combinations
     */
    async generateUnhinged(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Get a variety of tracks with extreme features
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

    // WEEKLY CURATED MIXES (20 tracks)

    /**
     * "Deep Cuts" - Hidden gems from your library
     * Tracks with playCount < 3 from artists you play often
     */
    async generateDeepCuts(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Track has no plays relation. Get unplayed track IDs via raw query.
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
            // Fallback: tracks with few plays (raw count)
            const playCounts = await prisma.$queryRaw<{ trackId: string; c: number }[]>`
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
     * "Key Journey" - Harmonic progression
     * Tracks ordered by circle of fifths key progression
     */
    async generateKeyJourney(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Circle of fifths order
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

        // Group by key
        const byKey = new Map<string, typeof tracks>();
        for (const track of tracks) {
            const key = track.key || "C";
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key)!.push(track);
        }

        // Build a journey through keys
        const journey: typeof tracks = [];
        const seed = getSeededRandom(`key-journey-${today}`);
        let seedVal = seed;

        for (const key of keyOrder) {
            const keyTracks = byKey.get(key) || [];
            if (
                keyTracks.length > 0 &&
                journey.length < WEEKLY_TRACK_LIMIT
            ) {
                // Pick 1-2 tracks from each key
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
     * "Tempo Flow" - Energy arc throughout
     * Start low BPM, build to peak, come down
     */
    async generateTempoFlow(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "completed",
                bpm: { not: null },
            },
            include: { album: { select: { coverUrl: true } } },
            take: 200,
        });

        if (tracks.length < 15) return null;

        // Sort by BPM
        const sorted = [...tracks].sort((a, b) => (a.bpm || 0) - (b.bpm || 0));

        // Build an arc: slow → fast → slow
        const slow = sorted.filter((t) => (t.bpm || 0) < 100);
        const medium = sorted.filter(
            (t) => (t.bpm || 0) >= 100 && (t.bpm || 0) < 130
        );
        const fast = sorted.filter((t) => (t.bpm || 0) >= 130);

        const flow: typeof tracks = [];

        // Intro: 4 slow tracks
        flow.push(...randomSample(slow, Math.min(4, slow.length)));
        // Build: 4 medium tracks
        flow.push(...randomSample(medium, Math.min(5, medium.length)));
        // Peak: 5 fast tracks
        flow.push(...randomSample(fast, Math.min(6, fast.length)));
        // Cool down: 3 medium tracks
        flow.push(
            ...randomSample(
                medium.filter((t) => !flow.includes(t)),
                Math.min(3, medium.length)
            )
        );
        // Outro: 3 slow tracks
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
     * "Vocal Detox" - Pure instrumental escape
     * instrumentalness > 0.8 + variety of moods
     */
    async generateVocalDetox(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
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
     * "Minor Key Mondays" - All minor key bangers
     * keyScale = 'minor' + energy > 0.5
     * Only available on Mondays
     */
    async generateMinorKeyMix(
        userId: string,
        today: string
    ): Promise<ProgrammaticMix | null> {
        // Only generate on Mondays (day 1)
        const dayOfWeek = new Date().getDay();
        if (dayOfWeek !== 1) return null;

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

    // MOOD ON DEMAND

    /**
     * Generate a custom mood mix based on audio feature parameters
     * Supports both basic audio features and ML mood predictions
     */
    async generateMoodOnDemand(
        userId: string,
        params: {
            // Basic audio features
            valence?: { min?: number; max?: number };
            energy?: { min?: number; max?: number };
            danceability?: { min?: number; max?: number };
            acousticness?: { min?: number; max?: number };
            instrumentalness?: { min?: number; max?: number };
            arousal?: { min?: number; max?: number };
            bpm?: { min?: number; max?: number };
            keyScale?: "major" | "minor";
            // ML mood predictions (require Enhanced mode analysis)
            moodHappy?: { min?: number; max?: number };
            moodSad?: { min?: number; max?: number };
            moodRelaxed?: { min?: number; max?: number };
            moodAggressive?: { min?: number; max?: number };
            moodParty?: { min?: number; max?: number };
            moodAcoustic?: { min?: number; max?: number };
            moodElectronic?: { min?: number; max?: number };
            limit?: number;
        }
    ): Promise<ProgrammaticMix | null> {
        const where: any = {
            analysisStatus: "completed",
        };

        // Check if any ML mood params are being used
        const mlMoodParams = [
            "moodHappy",
            "moodSad",
            "moodRelaxed",
            "moodAggressive",
            "moodParty",
            "moodAcoustic",
            "moodElectronic",
        ];
        const usesMLMoods = mlMoodParams.some(
            (key) => params[key as keyof typeof params] !== undefined
        );

        // First, check how many enhanced tracks we have
        let useEnhancedMode = false;
        if (usesMLMoods) {
            const enhancedCount = await prisma.track.count({
                where: {
                    analysisStatus: "completed",
                    analysisMode: "enhanced",
                },
            });

            // Only require enhanced mode if we have at least 15 enhanced tracks
            if (enhancedCount >= 15) {
                where.analysisMode = "enhanced";
                useEnhancedMode = true;
            } else {
                // Not enough enhanced tracks - convert ML mood params to basic audio feature equivalents
                logger.debug(
                    `[MoodMixer] Only ${enhancedCount} enhanced tracks, falling back to basic features`
                );

                // Map ML moods to basic audio features for fallback
                // This provides approximate matching when enhanced mode isn't available
                if (params.moodHappy) {
                    where.valence = where.valence || {};
                    if (params.moodHappy.min !== undefined)
                        where.valence.gte = Math.max(
                            where.valence.gte || 0,
                            params.moodHappy.min
                        );
                }
                if (params.moodSad) {
                    where.valence = where.valence || {};
                    if (params.moodSad.min !== undefined)
                        where.valence.lte = Math.min(
                            where.valence.lte || 1,
                            1 - params.moodSad.min
                        );
                }
                if (params.moodRelaxed) {
                    where.energy = where.energy || {};
                    if (params.moodRelaxed.min !== undefined)
                        where.energy.lte = Math.min(
                            where.energy.lte || 1,
                            1 - params.moodRelaxed.min * 0.5
                        );
                }
                if (params.moodAggressive) {
                    where.energy = where.energy || {};
                    if (params.moodAggressive.min !== undefined)
                        where.energy.gte = Math.max(
                            where.energy.gte || 0,
                            params.moodAggressive.min
                        );
                }
                if (params.moodParty) {
                    where.danceability = where.danceability || {};
                    if (params.moodParty.min !== undefined)
                        where.danceability.gte = Math.max(
                            where.danceability.gte || 0,
                            params.moodParty.min
                        );
                }
                // Clear the ML mood params since we're falling back
                delete params.moodHappy;
                delete params.moodSad;
                delete params.moodRelaxed;
                delete params.moodAggressive;
                delete params.moodParty;
                delete params.moodAcoustic;
                delete params.moodElectronic;
            }
        }

        // Basic audio feature filters - merge with any existing from fallback
        if (params.valence) {
            where.valence = where.valence || {};
            if (params.valence.min !== undefined)
                where.valence.gte = Math.max(
                    where.valence.gte || 0,
                    params.valence.min
                );
            if (params.valence.max !== undefined)
                where.valence.lte = Math.min(
                    where.valence.lte ?? 1,
                    params.valence.max
                );
        }
        if (params.energy) {
            where.energy = where.energy || {};
            if (params.energy.min !== undefined)
                where.energy.gte = Math.max(
                    where.energy.gte || 0,
                    params.energy.min
                );
            if (params.energy.max !== undefined)
                where.energy.lte = Math.min(
                    where.energy.lte ?? 1,
                    params.energy.max
                );
        }
        if (params.danceability) {
            where.danceability = where.danceability || {};
            if (params.danceability.min !== undefined)
                where.danceability.gte = Math.max(
                    where.danceability.gte || 0,
                    params.danceability.min
                );
            if (params.danceability.max !== undefined)
                where.danceability.lte = Math.min(
                    where.danceability.lte ?? 1,
                    params.danceability.max
                );
        }
        if (params.acousticness) {
            where.acousticness = {};
            if (params.acousticness.min !== undefined)
                where.acousticness.gte = params.acousticness.min;
            if (params.acousticness.max !== undefined)
                where.acousticness.lte = params.acousticness.max;
        }
        if (params.instrumentalness) {
            where.instrumentalness = {};
            if (params.instrumentalness.min !== undefined)
                where.instrumentalness.gte = params.instrumentalness.min;
            if (params.instrumentalness.max !== undefined)
                where.instrumentalness.lte = params.instrumentalness.max;
        }
        if (params.arousal) {
            where.arousal = {};
            if (params.arousal.min !== undefined)
                where.arousal.gte = params.arousal.min;
            if (params.arousal.max !== undefined)
                where.arousal.lte = params.arousal.max;
        }
        if (params.bpm) {
            where.bpm = {};
            if (params.bpm.min !== undefined) where.bpm.gte = params.bpm.min;
            if (params.bpm.max !== undefined) where.bpm.lte = params.bpm.max;
        }
        if (params.keyScale) {
            where.keyScale = params.keyScale;
        }

        // ML mood prediction filters
        if (params.moodHappy) {
            where.moodHappy = {};
            if (params.moodHappy.min !== undefined)
                where.moodHappy.gte = params.moodHappy.min;
            if (params.moodHappy.max !== undefined)
                where.moodHappy.lte = params.moodHappy.max;
        }
        if (params.moodSad) {
            where.moodSad = {};
            if (params.moodSad.min !== undefined)
                where.moodSad.gte = params.moodSad.min;
            if (params.moodSad.max !== undefined)
                where.moodSad.lte = params.moodSad.max;
        }
        if (params.moodRelaxed) {
            where.moodRelaxed = {};
            if (params.moodRelaxed.min !== undefined)
                where.moodRelaxed.gte = params.moodRelaxed.min;
            if (params.moodRelaxed.max !== undefined)
                where.moodRelaxed.lte = params.moodRelaxed.max;
        }
        if (params.moodAggressive) {
            where.moodAggressive = {};
            if (params.moodAggressive.min !== undefined)
                where.moodAggressive.gte = params.moodAggressive.min;
            if (params.moodAggressive.max !== undefined)
                where.moodAggressive.lte = params.moodAggressive.max;
        }
        if (params.moodParty) {
            where.moodParty = {};
            if (params.moodParty.min !== undefined)
                where.moodParty.gte = params.moodParty.min;
            if (params.moodParty.max !== undefined)
                where.moodParty.lte = params.moodParty.max;
        }
        if (params.moodAcoustic) {
            where.moodAcoustic = {};
            if (params.moodAcoustic.min !== undefined)
                where.moodAcoustic.gte = params.moodAcoustic.min;
            if (params.moodAcoustic.max !== undefined)
                where.moodAcoustic.lte = params.moodAcoustic.max;
        }
        if (params.moodElectronic) {
            where.moodElectronic = {};
            if (params.moodElectronic.min !== undefined)
                where.moodElectronic.gte = params.moodElectronic.min;
            if (params.moodElectronic.max !== undefined)
                where.moodElectronic.lte = params.moodElectronic.max;
        }

        const tracks = await prisma.track.findMany({
            where,
            include: { album: { select: { coverUrl: true } } },
            take: 100,
        });

        const limit = params.limit || 15;
        if (tracks.length < Math.min(limit, 8)) return null;

        const shuffled = randomSample(tracks, limit);
        const coverUrls = shuffled
            .filter((t) => t.album.coverUrl)
            .slice(0, 4)
            .map((t) => t.album.coverUrl!);

        const timestamp = Date.now();
        return {
            id: `mood-on-demand-${timestamp}`,
            type: "mood-on-demand",
            name: "Custom Mood Mix",
            description: `Generated just for you`,
            trackIds: shuffled.map((t) => t.id),
            coverUrls,
            trackCount: shuffled.length,
            color: getMixColor("mood"),
        };
    }
}

export const programmaticPlaylistService = new ProgrammaticPlaylistService();
