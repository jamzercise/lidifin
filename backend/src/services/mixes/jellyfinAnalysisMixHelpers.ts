import type { Prisma } from "@prisma/client";
import { prisma } from "@/utils/db";
import { resolveTrackReferences } from "@/services/jellyfin";
import { getMixColor } from "./colors";
import {
    DAILY_TRACK_LIMIT,
    MIN_TRACKS_DAILY,
    MIN_TRACKS_WEEKLY,
    TRACK_LIMIT,
    WEEKLY_TRACK_LIMIT,
} from "./constants";
import { getSeededRandom, randomSample } from "./helpers";
import type { ProgrammaticMix, ProgrammaticMixType } from "./types";

export type MixColorKey = Parameters<typeof getMixColor>[0];

export async function jellyfinAnalysisIds(
    extraWhere: Prisma.JellyfinTrackAnalysisWhereInput,
    take: number
): Promise<string[]> {
    const rows = await prisma.jellyfinTrackAnalysis.findMany({
        where: {
            analysisStatus: "completed",
            ...extraWhere,
        },
        select: { jellyfinTrackId: true },
        take,
    });
    return rows.map((r) => r.jellyfinTrackId);
}

export async function jellyfinMetadataIdsByLastfmTags(
    tags: string[],
    take: number
): Promise<string[]> {
    if (tags.length === 0) return [];
    const rows = await prisma.jellyfinTrackMetadata.findMany({
        where: {
            AND: [
                { lastfmTags: { hasSome: tags } },
                { NOT: { lastfmTags: { has: "_no_mood_tags" } } },
                { NOT: { lastfmTags: { has: "_not_found" } } },
            ],
        },
        select: { jellyfinId: true },
        take,
    });
    return rows.map((r) => r.jellyfinId);
}

/**
 * Match genre-style mixes: Jellyfin metadata genres + lastfm tags.
 */
export async function jellyfinMetadataIdsByGenrePatterns(
    patterns: string[],
    take: number
): Promise<string[]> {
    if (patterns.length === 0) return [];
    const lowered = patterns.map((p) => p.toLowerCase());
    const rows = await prisma.jellyfinTrackMetadata.findMany({
        where: {
            OR: [
                { genres: { hasSome: lowered } },
                { lastfmTags: { hasSome: lowered } },
            ],
        },
        select: { jellyfinId: true },
        take,
    });
    return rows.map((r) => r.jellyfinId);
}

export function mergeUniqueTrackIds(...lists: string[][]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const list of lists) {
        for (const id of list) {
            if (!seen.has(id)) {
                seen.add(id);
                out.push(id);
            }
        }
    }
    return out;
}

export async function buildJellyfinProgrammaticMix(options: {
    id: string;
    type: ProgrammaticMixType;
    name: string;
    description: string;
    candidateIds: string[];
    today: string;
    mixSeedSuffix: string;
    colorKey: MixColorKey;
    trackLimit?: number;
    /** Default 15; vibe/day mixes may use 8. */
    minCandidates?: number;
}): Promise<ProgrammaticMix | null> {
    const {
        candidateIds,
        today,
        mixSeedSuffix,
        trackLimit = TRACK_LIMIT,
        minCandidates = 15,
    } = options;
    if (candidateIds.length < minCandidates) return null;

    const seed = getSeededRandom(`${mixSeedSuffix}-${today}`);
    let random = seed;
    const shuffled = [...candidateIds].sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const selectedIds = shuffled.slice(0, trackLimit);
    const resolved = await resolveTrackReferences(selectedIds);
    const coverUrls = resolved
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => t.album.coverArt)
        .filter((u): u is string => !!u)
        .slice(0, 4);

    return {
        id: options.id,
        type: options.type,
        name: options.name,
        description: options.description,
        trackIds: selectedIds,
        coverUrls,
        trackCount: selectedIds.length,
        color: getMixColor(options.colorKey),
    };
}

/** Curated vibe-style mixes: randomSample from pool, Jellyfin ids. */
export async function buildJellyfinDailyVibeMix(options: {
    candidateIds: string[];
    minPool?: number;
    today: string;
    id: string;
    type: ProgrammaticMixType;
    name: string;
    description: string;
    colorKey: MixColorKey;
}): Promise<ProgrammaticMix | null> {
    const minPool = options.minPool ?? 8;
    if (options.candidateIds.length < minPool) return null;
    const shuffled = randomSample(options.candidateIds, DAILY_TRACK_LIMIT);
    const resolved = await resolveTrackReferences(shuffled);
    const coverUrls = resolved
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => t.album.coverArt)
        .filter((u): u is string => !!u)
        .slice(0, 4);
    return {
        id: options.id,
        type: options.type,
        name: options.name,
        description: options.description,
        trackIds: shuffled,
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor(options.colorKey),
    };
}

/** Weekly-style mix from a Jellyfin analysis pool (e.g. vocal detox). */
export async function buildJellyfinWeeklyPoolMix(options: {
    candidateIds: string[];
    today: string;
    id: string;
    type: ProgrammaticMixType;
    name: string;
    description: string;
    colorKey: MixColorKey;
    minPool?: number;
    limit?: number;
}): Promise<ProgrammaticMix | null> {
    const minPool = options.minPool ?? 15;
    const limit = options.limit ?? WEEKLY_TRACK_LIMIT;
    if (options.candidateIds.length < minPool) return null;
    const shuffled = randomSample(options.candidateIds, limit);
    const resolved = await resolveTrackReferences(shuffled);
    const coverUrls = resolved
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => t.album.coverArt)
        .filter((u): u is string => !!u)
        .slice(0, 4);
    return {
        id: options.id,
        type: options.type,
        name: options.name,
        description: options.description,
        trackIds: shuffled,
        coverUrls,
        trackCount: shuffled.length,
        color: getMixColor(options.colorKey),
    };
}

/** Chill / late-night style: daily vs weekly cap from pool size. */
export async function buildJellyfinChillStyleMix(options: {
    id: string;
    type: ProgrammaticMixType;
    name: string;
    description: string;
    candidateIds: string[];
    today: string;
    mixSeedSuffix: string;
    colorKey: MixColorKey;
}): Promise<ProgrammaticMix | null> {
    const { candidateIds, today, mixSeedSuffix } = options;
    if (candidateIds.length < MIN_TRACKS_DAILY) return null;

    const seed = getSeededRandom(`${mixSeedSuffix}-${today}`);
    let random = seed;
    const shuffled = [...candidateIds].sort(() => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280 - 0.5;
    });

    const isWeekly = candidateIds.length >= MIN_TRACKS_WEEKLY;
    const trackLimit = isWeekly ? WEEKLY_TRACK_LIMIT : DAILY_TRACK_LIMIT;
    const selectedIds = shuffled.slice(0, trackLimit);
    const resolved = await resolveTrackReferences(selectedIds);
    const coverUrls = resolved
        .filter((t): t is NonNullable<typeof t> => t !== null)
        .map((t) => t.album.coverArt)
        .filter((u): u is string => !!u)
        .slice(0, 4);

    return {
        id: options.id,
        type: options.type,
        name: options.name,
        description: options.description,
        trackIds: selectedIds,
        coverUrls,
        trackCount: selectedIds.length,
        color: getMixColor(options.colorKey),
    };
}
