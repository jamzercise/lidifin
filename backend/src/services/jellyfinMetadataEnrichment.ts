/**
 * Jellyfin Track Metadata Enrichment
 *
 * Enriches JellyfinTrackMetadata with Last.fm mood tags (for By Vibe radio)
 * and genre tags (for Genre radio). Runs after sync.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { lastFmService } from "./lastfm";
import { isJellyfinMusicSource } from "./jellyfin";
import pLimit from "p-limit";

const BATCH_SIZE = 50;
const CONCURRENCY = 4;

// Same mood tags as unifiedEnrichment (keep in sync)
const MOOD_TAGS = new Set([
    "chill", "relax", "relaxing", "calm", "peaceful", "ambient",
    "energetic", "upbeat", "hype", "party", "dance", "workout", "gym", "running", "exercise", "motivation",
    "sad", "melancholy", "melancholic", "depressing", "heartbreak", "happy", "feel good", "feel-good", "joyful", "uplifting",
    "angry", "aggressive", "intense", "romantic", "love", "sensual",
    "night", "late night", "evening", "morning", "summer", "winter", "rainy", "sunny", "driving", "road trip", "travel",
    "study", "focus", "concentration", "work", "sleep", "sleeping", "bedtime",
    "dreamy", "atmospheric", "ethereal", "spacey", "groovy", "funky", "smooth", "dark", "moody", "brooding", "epic", "cinematic", "dramatic", "nostalgic", "throwback",
]);

function filterMoodTags(tags: string[]): string[] {
    return tags
        .map((t) => t.toLowerCase().trim())
        .filter((t) => {
            if (MOOD_TAGS.has(t)) return true;
            for (const mood of MOOD_TAGS) {
                if (t.includes(mood)) return true;
            }
            return false;
        })
        .slice(0, 10);
}

/** Extract genre tags (tags that are NOT mood tags) - e.g. rock, pop, jazz */
function extractGenreTags(tags: string[]): string[] {
    return tags
        .map((t) => t.toLowerCase().trim())
        .filter((t) => {
            if (!t || t.length < 2) return false;
            if (MOOD_TAGS.has(t)) return false;
            for (const mood of MOOD_TAGS) {
                if (t.includes(mood)) return false;
            }
            return true;
        })
        .slice(0, 10);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
    let t: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error(msg)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t!));
}

export interface EnrichmentResult {
    enriched: number;
    durationMs: number;
}

/**
 * Enrich JellyfinTrackMetadata rows with Last.fm tags.
 * Processes rows with empty lastfmTags first.
 */
export async function enrichJellyfinTrackMetadata(): Promise<EnrichmentResult | null> {
    if (!(await isJellyfinMusicSource())) {
        return null;
    }

    // Process rows that need lastfmTags OR genres (enrich both in one pass)
    const rows = await prisma.jellyfinTrackMetadata.findMany({
        where: {
            OR: [
                { lastfmTags: { isEmpty: true } },
                { lastfmTags: { equals: [] } },
                { genres: { isEmpty: true } },
                { genres: { equals: [] } },
            ],
        },
        take: BATCH_SIZE,
        orderBy: { updatedAt: "asc" },
    });

    if (rows.length === 0) return { enriched: 0, durationMs: 0 };

    const start = Date.now();
    const limit = pLimit(CONCURRENCY);
    let enriched = 0;

    await Promise.allSettled(
        rows.map((row) =>
            limit(async () => {
                try {
                    const trackInfo = await withTimeout(
                        lastFmService.getTrackInfo(row.artistName, row.trackTitle),
                        30000,
                        `Timeout: ${row.trackTitle}`,
                    );

                    let moodTags: string[] = [];
                    let allTags: string[] = [];

                    if (trackInfo?.toptags?.tag) {
                        const tagNames = trackInfo.toptags.tag.map((t: any) => (typeof t === "string" ? t : t.name));
                        moodTags = filterMoodTags(tagNames);
                        allTags = tagNames;
                    }

                    let artistInfo: any = null;
                    if (moodTags.length === 0 || allTags.length < 5) {
                        artistInfo = await withTimeout(
                            lastFmService.getArtistInfo(row.artistName),
                            15000,
                            `Timeout artist: ${row.artistName}`,
                        );
                        if (artistInfo?.tags?.tag) {
                            const artistTagNames = artistInfo.tags.tag.map((t: any) => (typeof t === "string" ? t : t.name));
                            if (moodTags.length === 0) {
                                moodTags = filterMoodTags(artistTagNames);
                            }
                            allTags = [...new Set([...allTags, ...artistTagNames])];
                        }
                    }

                    if (moodTags.length === 0 && row.albumTitle) {
                        const albumInfo = await withTimeout(
                            lastFmService.getAlbumInfo(row.artistName, row.albumTitle),
                            15000,
                            `Timeout album: ${row.albumTitle}`,
                        );
                        if (albumInfo?.tags?.tag) {
                            const albumTagNames = albumInfo.tags.tag.map((t: any) => (typeof t === "string" ? t : t.name));
                            moodTags = filterMoodTags(albumTagNames);
                            allTags = [...new Set([...allTags, ...albumTagNames])];
                        }
                    }

                    // Fetch artistInfo for genres if we don't have it yet
                    if (!artistInfo && allTags.length < 5) {
                        artistInfo = await withTimeout(
                            lastFmService.getArtistInfo(row.artistName),
                            15000,
                            `Timeout artist: ${row.artistName}`,
                        );
                        if (artistInfo?.tags?.tag) {
                            const artistTagNames = artistInfo.tags.tag.map((t: any) => (typeof t === "string" ? t : t.name));
                            allTags = [...new Set([...allTags, ...artistTagNames])];
                        }
                    }

                    const tags =
                        moodTags.length > 0
                            ? moodTags
                            : trackInfo === null
                              ? ["_not_found"]
                              : ["_no_mood_tags"];

                    const genreTags = extractGenreTags(allTags);

                    await prisma.jellyfinTrackMetadata.update({
                        where: { jellyfinId: row.jellyfinId },
                        data: {
                            lastfmTags: tags,
                            genres: genreTags,
                            lastEnriched: new Date(),
                            updatedAt: new Date(),
                        },
                    });
                    enriched++;
                    if (moodTags.length > 0 || genreTags.length > 0) {
                        logger.debug(
                            `[JellyfinEnrich] ${row.artistName} - ${row.trackTitle}: moods=[${moodTags.slice(0, 2).join(", ")}] genres=[${genreTags.slice(0, 3).join(", ")}]`,
                        );
                    }
                } catch (err: any) {
                    logger.debug(`[JellyfinEnrich] Failed ${row.trackTitle}: ${err?.message}`);
                }
            }),
        ),
    );

    const durationMs = Date.now() - start;
    if (enriched > 0) {
        logger.debug(`[JellyfinEnrich] Enriched ${enriched}/${rows.length} in ${durationMs}ms`);
    }
    return { enriched, durationMs };
}
