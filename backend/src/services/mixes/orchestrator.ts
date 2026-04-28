import { logger } from "../../utils/logger";
import { isJellyfinMusicSource } from "../jellyfin";
import { moodBucketService } from "../moodBucketService";
import { DAILY_MIX_COUNT } from "./constants";
import { getSeededRandom } from "./helpers";
import type { ProgrammaticMix } from "./types";

import {
    generateArtistSimilarMix,
    generateEraMix,
    generateGenreMix,
    generateRandomDiscoveryMix,
    generateRediscoverMix,
    generateTopTracksMix,
} from "./generators/core";
import {
    generateChillMix,
    generateFocusMix,
    generateHighEnergyMix,
    generateLateNightMix,
    generatePartyMix,
    generateWorkoutMix,
} from "./generators/activity";
import {
    generateAcousticMix,
    generateDanceFloorMix,
    generateHappyMix,
    generateInstrumentalMix,
    generateMelancholyMix,
    generateRoadTripMix,
} from "./generators/mood";
import {
    generateJellyfinArtistDeepDiveMix,
    generateJellyfinDeepCutsMix,
    generateJellyfinDiscoveryMix,
    generateJellyfinGenreMix,
    generateJellyfinMoodMix,
    generateJellyfinRecentlyAddedMix,
} from "./generators/jellyfin";
import { generateDayMix } from "./generators/days";
import {
    generate3AMThoughts,
    generateCoffeeShopVibes,
    generateGoldenHour,
    generateHotGirlWalk,
    generateInMyFeelings,
    generateMainCharacterEnergy,
    generateMidnightDrive,
    generateRageCleaning,
    generateRomanticizeYourLife,
    generateSadGirlSundays,
    generateShowerKaraoke,
    generateThatGirlEra,
    generateUnhinged,
    generateVillainEra,
} from "./generators/vibe";
import {
    generateDeepCuts,
    generateKeyJourney,
    generateMinorKeyMix,
    generateTempoFlow,
    generateVocalDetox,
} from "./generators/advanced";

/**
 * Generate the user's daily set of mixes.
 *
 * Selects DAILY_MIX_COUNT mixes from the catalog, biasing toward
 * Jellyfin generators when Jellyfin is the active music source.
 * Falls back to other generators if any selected one returns null.
 * Appends the user's saved mood mix if one exists.
 */
export async function generateAllMixes(
    userId: string,
    forceRandom = false
): Promise<ProgrammaticMix[]> {
    const today = new Date().toISOString().split("T")[0];
    const seedString = forceRandom
        ? `${userId}-${Date.now()}-${Math.random()}`
        : `${today}-${userId}`;
    const dateSeed = getSeededRandom(seedString);

    logger.debug(
        `[MIXES] Generating mixes for user ${userId}, forceRandom: ${forceRandom}, seed: ${dateSeed}`
    );

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
            fn: () => generateRandomDiscoveryMix(userId, today + seedSuffix),
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
            fn: () => generateJellyfinDeepCutsMix(userId, today + seedSuffix),
            weight: 3,
            name: "Jellyfin Deep Cuts",
            jellyfinOnly: true,
        },
        {
            fn: () => generateJellyfinRecentlyAddedMix(today + seedSuffix),
            weight: 3,
            name: "Jellyfin Recently Added",
            jellyfinOnly: true,
        },
        {
            fn: () =>
                generateJellyfinArtistDeepDiveMix(userId, today + seedSuffix),
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
        // Audio analysis-based mixes
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
            fn: () => generateDayMix(userId),
            weight: 1,
            name: "Day Mix",
        },
        // Curated Vibe Mixes (Daily, 10 tracks)
        {
            fn: () => generateSadGirlSundays(userId, today + seedSuffix),
            weight: 2,
            name: "Sad Girl Sundays",
        },
        {
            fn: () => generateMainCharacterEnergy(userId, today + seedSuffix),
            weight: 2,
            name: "Main Character Energy",
        },
        {
            fn: () => generateVillainEra(userId, today + seedSuffix),
            weight: 2,
            name: "Villain Era",
        },
        {
            fn: () => generate3AMThoughts(userId, today + seedSuffix),
            weight: 2,
            name: "3AM Thoughts",
        },
        {
            fn: () => generateHotGirlWalk(userId, today + seedSuffix),
            weight: 2,
            name: "Hot Girl Walk",
        },
        {
            fn: () => generateRageCleaning(userId, today + seedSuffix),
            weight: 2,
            name: "Rage Cleaning",
        },
        {
            fn: () => generateGoldenHour(userId, today + seedSuffix),
            weight: 2,
            name: "Golden Hour",
        },
        {
            fn: () => generateShowerKaraoke(userId, today + seedSuffix),
            weight: 2,
            name: "Shower Karaoke",
        },
        {
            fn: () => generateInMyFeelings(userId, today + seedSuffix),
            weight: 2,
            name: "In My Feelings",
        },
        {
            fn: () => generateMidnightDrive(userId, today + seedSuffix),
            weight: 2,
            name: "Midnight Drive",
        },
        {
            fn: () => generateCoffeeShopVibes(userId, today + seedSuffix),
            weight: 2,
            name: "Coffee Shop Vibes",
        },
        {
            fn: () => generateRomanticizeYourLife(userId, today + seedSuffix),
            weight: 2,
            name: "Romanticize Your Life",
        },
        {
            fn: () => generateThatGirlEra(userId, today + seedSuffix),
            weight: 2,
            name: "That Girl Era",
        },
        {
            fn: () => generateUnhinged(userId, today + seedSuffix),
            weight: 2,
            name: "Unhinged",
        },
        // Weekly Curated Mixes (20 tracks)
        {
            fn: () => generateDeepCuts(userId, today + seedSuffix),
            weight: 1,
            name: "Deep Cuts",
        },
        {
            fn: () => generateKeyJourney(userId, today + seedSuffix),
            weight: 1,
            name: "Key Journey",
        },
        {
            fn: () => generateTempoFlow(userId, today + seedSuffix),
            weight: 1,
            name: "Tempo Flow",
        },
        {
            fn: () => generateVocalDetox(userId, today + seedSuffix),
            weight: 1,
            name: "Vocal Detox",
        },
        {
            fn: () => generateMinorKeyMix(userId, today + seedSuffix),
            weight: 1,
            name: "Minor Key Mondays",
        },
    ];

    const selectedIndices: number[] = [];
    let seed = dateSeed;

    const isJellyfin = await isJellyfinMusicSource();
    const JELLYFIN_RESERVED_SLOTS = isJellyfin ? 2 : 0;

    if (isJellyfin && JELLYFIN_RESERVED_SLOTS > 0) {
        const jellyfinIndices = mixGenerators
            .map((g, i) => ({
                index: i,
                isJellyfin:
                    "jellyfinOnly" in g && (g as any).jellyfinOnly,
            }))
            .filter((g) => g.isJellyfin)
            .map((g) => g.index);

        if (jellyfinIndices.length > 0) {
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

    let finalMixes = mixes.filter(
        (mix): mix is ProgrammaticMix => mix !== null
    );
    logger.debug(
        `[MIXES] Returning ${finalMixes.length} mixes after filtering nulls`
    );

    if (finalMixes.length < DAILY_MIX_COUNT) {
        logger.debug(
            `[MIXES] Only got ${finalMixes.length} mixes, trying to fill gaps...`
        );

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
