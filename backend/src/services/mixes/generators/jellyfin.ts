import { prisma } from "../../../utils/db";
import {
    isJellyfinMusicSource,
    resolveTrackReferences,
} from "../../jellyfin";
import { TRACK_LIMIT } from "../constants";
import { getMixColor } from "../colors";
import { getSeededRandom, randomSample } from "../helpers";
import type { ProgrammaticMix } from "../types";

/**
 * Jellyfin-only: Genre mix from JellyfinTrackMetadata.genres
 */
export async function generateJellyfinGenreMix(
    today: string
): Promise<ProgrammaticMix | null> {
    if (!(await isJellyfinMusicSource())) return null;

    const genreCounts = await prisma.$queryRaw<
        { genre: string; c: number }[]
    >`
        SELECT unnest("genres") as genre, COUNT(*)::int as c
        FROM "JellyfinTrackMetadata"
        WHERE array_length("genres", 1) > 0
        GROUP BY genre
        HAVING COUNT(*) >= 10
        ORDER BY c DESC
    `;
    if (genreCounts.length === 0) return null;

    const seed = getSeededRandom(`jf-genre-${today}`);
    const idx = seed % genreCounts.length;
    const genre = genreCounts[idx].genre.toLowerCase();

    const rows = await prisma.jellyfinTrackMetadata.findMany({
        where: { genres: { has: genre } },
        select: { jellyfinId: true },
        take: TRACK_LIMIT * 2,
    });
    const trackIds = rows.map((r) => r.jellyfinId);
    if (trackIds.length < 5) return null;

    const selected = randomSample(trackIds, TRACK_LIMIT);

    const resolved = await resolveTrackReferences(selected);
    const valid = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
    if (valid.length < 5) return null;

    const coverUrls = valid
        .filter((t) => t.album?.coverArt)
        .slice(0, 4)
        .map((t) => t.album!.coverArt!);

    const displayGenre = genre.charAt(0).toUpperCase() + genre.slice(1);
    return {
        id: `jellyfin-genre-${genre}-${today}`,
        type: "genre",
        name: `Your ${displayGenre} Mix`,
        description: `Random ${displayGenre} picks from your library`,
        trackIds: valid.map((t) => t.id),
        coverUrls,
        trackCount: valid.length,
        color: getMixColor("genre"),
    };
}

/**
 * Jellyfin-only: Random discovery from JellyfinTrackMetadata
 */
export async function generateJellyfinDiscoveryMix(
    today: string
): Promise<ProgrammaticMix | null> {
    if (!(await isJellyfinMusicSource())) return null;

    const rows = await prisma.$queryRaw<{ jellyfinId: string }[]>`
        SELECT "jellyfinId" FROM "JellyfinTrackMetadata"
        WHERE "jellyfinId" IS NOT NULL AND "jellyfinId" != ''
        ORDER BY RANDOM()
        LIMIT ${TRACK_LIMIT * 2}
    `;
    const trackIds = rows.map((r) => r.jellyfinId);
    if (trackIds.length < 5) return null;

    const selected = trackIds.slice(0, TRACK_LIMIT);
    const resolved = await resolveTrackReferences(selected);
    const valid = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
    if (valid.length < 5) return null;

    const coverUrls = valid
        .filter((t) => t.album?.coverArt)
        .slice(0, 4)
        .map((t) => t.album!.coverArt!);

    return {
        id: `jellyfin-discovery-${today}`,
        type: "discovery",
        name: "Discovery",
        description: "Random picks from your library",
        trackIds: valid.map((t) => t.id),
        coverUrls,
        trackCount: valid.length,
        color: getMixColor("discovery"),
    };
}

/**
 * Jellyfin-only: Mood mix from JellyfinTrackMetadata.lastfmTags
 */
export async function generateJellyfinMoodMix(
    today: string
): Promise<ProgrammaticMix | null> {
    if (!(await isJellyfinMusicSource())) return null;

    const MOOD_TAG_MAP: Record<string, string[]> = {
        chill: ["chill", "chillout", "relaxing", "calm", "mellow", "ambient"],
        energetic: ["energetic", "high energy", "upbeat", "powerful"],
        sad: ["sad", "melancholy", "depressing", "dark", "melancholic"],
        romantic: ["romantic", "love", "love songs", "romance"],
        focus: ["focus", "ambient", "instrumental", "background"],
    };
    const moods = Object.keys(MOOD_TAG_MAP);
    const seed = getSeededRandom(`jf-mood-${today}`);
    const moodKey = moods[seed % moods.length];
    const tags = MOOD_TAG_MAP[moodKey];

    const rows = await prisma.jellyfinTrackMetadata.findMany({
        where: {
            AND: [
                { lastfmTags: { hasSome: tags } },
                { NOT: { lastfmTags: { has: "_no_mood_tags" } } },
                { NOT: { lastfmTags: { has: "_not_found" } } },
            ],
        },
        select: { jellyfinId: true },
        take: TRACK_LIMIT * 2,
    });
    const trackIds = rows.map((r) => r.jellyfinId);
    if (trackIds.length < 5) return null;

    const selected = randomSample(trackIds, TRACK_LIMIT);

    const resolved = await resolveTrackReferences(selected);
    const valid = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
    if (valid.length < 5) return null;

    const coverUrls = valid
        .filter((t) => t.album?.coverArt)
        .slice(0, 4)
        .map((t) => t.album!.coverArt!);

    const moodNames: Record<string, string> = {
        chill: "Chill & Relaxed",
        energetic: "High Energy",
        sad: "Melancholic",
        romantic: "Romantic",
        focus: "Focus Mode",
    };
    const moodName = moodNames[moodKey] ?? moodKey;

    return {
        id: `jellyfin-mood-${moodKey}-${today}`,
        type: "mood",
        name: `${moodName} Mix`,
        description: `Tracks that match the ${moodName.toLowerCase()} vibe`,
        trackIds: valid.map((t) => t.id),
        coverUrls,
        trackCount: valid.length,
        color: getMixColor("chill"),
    };
}

/**
 * Jellyfin-only: Deep Cuts — least-played tracks from the Jellyfin library
 */
export async function generateJellyfinDeepCutsMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    if (!(await isJellyfinMusicSource())) return null;

    const playedTrackIds = await prisma.play.groupBy({
        by: ["trackId"],
        where: { userId, trackId: { startsWith: "jellyfin:" } },
        _count: { id: true },
        orderBy: { _count: { id: "asc" } },
    });
    const playedSet = new Set(playedTrackIds.map((p) => p.trackId));

    const allTracks = await prisma.jellyfinTrackMetadata.findMany({
        select: { jellyfinId: true },
        take: 500,
    });

    const neverPlayed = allTracks
        .filter((t) => !playedSet.has(t.jellyfinId))
        .map((t) => t.jellyfinId);

    const pool =
        neverPlayed.length >= TRACK_LIMIT
            ? neverPlayed
            : [
                  ...neverPlayed,
                  ...playedTrackIds.slice(0, 50).map((p) => p.trackId),
              ];

    if (pool.length < 5) return null;

    const selected = randomSample(pool, TRACK_LIMIT);
    const resolved = await resolveTrackReferences(selected);
    const valid = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
    if (valid.length < 5) return null;

    const coverUrls = valid
        .filter((t) => t.album?.coverArt)
        .slice(0, 4)
        .map((t) => t.album!.coverArt!);

    return {
        id: `jellyfin-deep-cuts-${today}`,
        type: "deep-cuts",
        name: "Deep Cuts",
        description: "Hidden gems you haven't played much",
        trackIds: valid.map((t) => t.id),
        coverUrls,
        trackCount: valid.length,
        color: getMixColor("discovery"),
    };
}

/**
 * Jellyfin-only: Recently Added — newest tracks added to the Jellyfin library
 */
export async function generateJellyfinRecentlyAddedMix(
    today: string
): Promise<ProgrammaticMix | null> {
    if (!(await isJellyfinMusicSource())) return null;

    const rows = await prisma.jellyfinTrackMetadata.findMany({
        select: { jellyfinId: true },
        orderBy: { createdAt: "desc" },
        take: TRACK_LIMIT * 2,
    });
    const trackIds = rows.map((r) => r.jellyfinId);
    if (trackIds.length < 5) return null;

    const selected = trackIds.slice(0, TRACK_LIMIT);
    const resolved = await resolveTrackReferences(selected);
    const valid = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
    if (valid.length < 5) return null;

    const coverUrls = valid
        .filter((t) => t.album?.coverArt)
        .slice(0, 4)
        .map((t) => t.album!.coverArt!);

    return {
        id: `jellyfin-recently-added-${today}`,
        type: "recently-added",
        name: "Fresh Additions",
        description: "Newest tracks in your library",
        trackIds: valid.map((t) => t.id),
        coverUrls,
        trackCount: valid.length,
        color: getMixColor("happy"),
    };
}

/**
 * Jellyfin-only: Artist Deep Dive — full catalog from one of your most-played artists
 */
export async function generateJellyfinArtistDeepDiveMix(
    userId: string,
    today: string
): Promise<ProgrammaticMix | null> {
    if (!(await isJellyfinMusicSource())) return null;

    const topPlayed = await prisma.play.groupBy({
        by: ["trackId"],
        where: { userId, trackId: { startsWith: "jellyfin:" } },
        _count: { id: true },
        orderBy: { _count: { id: "desc" } },
        take: 100,
    });
    if (topPlayed.length === 0) return null;

    const trackIds = topPlayed.map((p) => p.trackId);
    const rawIds = trackIds.map((id) =>
        id.startsWith("jellyfin:") ? id : `jellyfin:${id}`
    );

    const metadata = await prisma.jellyfinTrackMetadata.findMany({
        where: { jellyfinId: { in: rawIds } },
        select: { jellyfinId: true, artistName: true },
    });

    const artistCounts = new Map<string, number>();
    for (const m of metadata) {
        const count = artistCounts.get(m.artistName) || 0;
        artistCounts.set(m.artistName, count + 1);
    }

    const sortedArtists = Array.from(artistCounts.entries()).sort(
        (a, b) => b[1] - a[1]
    );
    if (sortedArtists.length === 0) return null;

    const seed = getSeededRandom(`jf-deepdive-${today}`);
    const pickFrom = sortedArtists.slice(0, Math.min(5, sortedArtists.length));
    const [artistName] = pickFrom[seed % pickFrom.length];

    const artistTracks = await prisma.jellyfinTrackMetadata.findMany({
        where: { artistName },
        select: { jellyfinId: true },
        take: TRACK_LIMIT * 2,
    });
    if (artistTracks.length < 5) return null;

    const selected = randomSample(
        artistTracks.map((t) => t.jellyfinId),
        TRACK_LIMIT
    );

    const resolved = await resolveTrackReferences(selected);
    const valid = resolved.filter((t): t is NonNullable<typeof t> => t !== null);
    if (valid.length < 5) return null;

    const coverUrls = valid
        .filter((t) => t.album?.coverArt)
        .slice(0, 4)
        .map((t) => t.album!.coverArt!);

    return {
        id: `jellyfin-artist-dive-${today}`,
        type: "artist-deep-dive",
        name: `${artistName} Deep Dive`,
        description: `A deep dive into ${artistName}'s catalog`,
        trackIds: valid.map((t) => t.id),
        coverUrls,
        trackCount: valid.length,
        color: getMixColor("rediscover"),
    };
}
