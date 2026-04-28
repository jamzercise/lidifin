import { prisma } from "@/utils/db";
import { logger } from "@/utils/logger";
import { getMixColor } from "../colors";
import { randomSample } from "../helpers";
import type { ProgrammaticMix } from "../types";

export interface MoodOnDemandParams {
    valence?: { min?: number; max?: number };
    energy?: { min?: number; max?: number };
    danceability?: { min?: number; max?: number };
    acousticness?: { min?: number; max?: number };
    instrumentalness?: { min?: number; max?: number };
    arousal?: { min?: number; max?: number };
    bpm?: { min?: number; max?: number };
    keyScale?: "major" | "minor";
    moodHappy?: { min?: number; max?: number };
    moodSad?: { min?: number; max?: number };
    moodRelaxed?: { min?: number; max?: number };
    moodAggressive?: { min?: number; max?: number };
    moodParty?: { min?: number; max?: number };
    moodAcoustic?: { min?: number; max?: number };
    moodElectronic?: { min?: number; max?: number };
    limit?: number;
}

/**
 * Generate a custom mood mix based on audio feature parameters.
 * Supports both basic audio features and ML mood predictions
 * (the latter require Enhanced-mode analysis; we fall back to
 * approximate basic features when not enough enhanced tracks exist).
 */
export async function generateMoodOnDemand(
    userId: string,
    params: MoodOnDemandParams
): Promise<ProgrammaticMix | null> {
    const where: any = {
        analysisStatus: "completed",
    };

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

    if (usesMLMoods) {
        const enhancedCount = await prisma.track.count({
            where: {
                analysisStatus: "completed",
                analysisMode: "enhanced",
            },
        });

        if (enhancedCount >= 15) {
            where.analysisMode = "enhanced";
        } else {
            logger.debug(
                `[MoodMixer] Only ${enhancedCount} enhanced tracks, falling back to basic features`
            );

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
            delete params.moodHappy;
            delete params.moodSad;
            delete params.moodRelaxed;
            delete params.moodAggressive;
            delete params.moodParty;
            delete params.moodAcoustic;
            delete params.moodElectronic;
        }
    }

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
