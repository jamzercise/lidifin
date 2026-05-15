/**
 * Programmatic Playlists service façade.
 *
 * Historically this file was a 4,300-line god class. It has been
 * decomposed into per-strategy modules under `./mixes/`:
 *
 *   - mixes/types.ts, constants.ts, colors.ts, helpers.ts (foundation)
 *   - mixes/generators/{core,activity,mood,jellyfin,days,vibe,advanced,moodOnDemand}.ts
 *   - mixes/orchestrator.ts (the daily-mix selection + dispatch)
 *
 * This file preserves the public API used by routes/mixes.ts:
 *   - `programmaticPlaylistService.generateAllMixes(userId, forceRandom?)`
 *   - `programmaticPlaylistService.generateMoodOnDemand(userId, params)`
 *   - `ProgrammaticMix` / `ProgrammaticMixType` type re-exports
 */

import { generateAllMixes } from "./mixes/orchestrator";
import {
    generateMoodOnDemand,
    type MoodOnDemandParams,
} from "./mixes/generators/moodOnDemand";
import type { ProgrammaticMix, ProgrammaticMixType } from "./mixes/types";

export type { ProgrammaticMix, ProgrammaticMixType };

export const programmaticPlaylistService = {
    generateAllMixes(
        userId: string,
        forceRandom = false
    ): Promise<ProgrammaticMix[]> {
        return generateAllMixes(userId, forceRandom);
    },

    generateMoodOnDemand(
        userId: string,
        params: MoodOnDemandParams
    ): Promise<ProgrammaticMix | null> {
        return generateMoodOnDemand(userId, params);
    },
};
