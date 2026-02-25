/**
 * Enriches Jellyfin artist responses with metadata from MusicBrainz, Last.fm, Fanart.tv, and Deezer.
 * Used when the library returns a Jellyfin artist to add bio, top tracks, similar artists, and discovery albums.
 */

import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { lastFmService } from "./lastfm";
import { musicBrainzService } from "./musicbrainz";
import { fanartService } from "./fanart";
import { deezerService } from "./deezer";
import { normalizeToArray } from "../utils/normalize";

const ENRICHMENT_CACHE_TTL = 3600; // 1 hour

export interface JellyfinArtistEnrichment {
    bio: string | null;
    image: string | null;
    genres: string[];
    listeners: number;
    playcount: number;
    topTracks: Array<{
        id: string;
        title: string;
        playCount: number;
        listeners: number;
        duration: number;
        url?: string;
        album: { title: string };
    }>;
    similarArtists: Array<{
        id: string;
        name: string;
        mbid: string | null;
        url?: string;
        image: string | null;
    }>;
    discoveryAlbums: Array<{
        id: string;
        rgMbid: string;
        title: string;
        type: string;
        year: number | null;
        coverUrl: string;
        owned: false;
    }>;
}

/**
 * Enrich a Jellyfin artist with metadata from external sources.
 * Returns null if enrichment fails (e.g. no Last.fm key); caller will use minimal fallback.
 */
export async function enrichJellyfinArtist(
    artistName: string,
    options: {
        mbid?: string | null;
        existingCoverArt?: string | null;
    } = {}
): Promise<JellyfinArtistEnrichment | null> {
    const { mbid: initialMbid, existingCoverArt } = options;
    const cacheKey = `jellyfin:artist:enriched:${initialMbid || artistName}`;

    try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            logger.debug(`[JellyfinEnrichment] Cache hit for ${artistName}`);
            return JSON.parse(cached) as JellyfinArtistEnrichment;
        }
    } catch (err) {
        logger.debug("[JellyfinEnrichment] Redis get error:", err);
    }

    let mbid: string | null = initialMbid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(initialMbid)
        ? initialMbid
        : null;
    let resolvedName = artistName;

    if (!mbid) {
        try {
            const mbResults = await musicBrainzService.searchArtist(artistName, 1);
            if (mbResults.length > 0) {
                mbid = mbResults[0].id;
                resolvedName = mbResults[0].name;
            }
        } catch (err) {
            logger.debug(`[JellyfinEnrichment] MusicBrainz search failed for ${artistName}:`, err);
        }
    } else {
        try {
            const mbArtist = await musicBrainzService.getArtist(mbid);
            resolvedName = mbArtist.name;
        } catch {
            // Keep resolvedName as artistName
        }
    }

    // Parallelize: Last.fm info + top tracks + images + MusicBrainz release groups
    const [lastFmInfo, topTracksRaw, fanartImage, deezerImage, releaseGroupsRaw] = await Promise.all([
        lastFmService.getArtistInfo(resolvedName, mbid || undefined),
        lastFmService.getArtistTopTracks(mbid || "", resolvedName, 10).catch(() => []),
        mbid ? fanartService.getArtistImage(mbid).catch(() => null) : Promise.resolve(null),
        deezerService.getArtistImage(resolvedName).catch(() => null),
        mbid ? musicBrainzService.getReleaseGroups(mbid).catch(() => []) : Promise.resolve([]),
    ]);

    let bio = lastFmInfo?.bio?.summary || null;
    if (bio) {
        const lowerBio = bio.toLowerCase();
        if (
            (lowerBio.includes("there are") &&
                (lowerBio.includes("artist") || lowerBio.includes("band")) &&
                lowerBio.includes("with the name")) ||
            lowerBio.includes("there is more than one artist") ||
            lowerBio.includes("multiple artists")
        ) {
            bio = null;
        }
    }

    const topTracks: JellyfinArtistEnrichment["topTracks"] = (Array.isArray(topTracksRaw) ? topTracksRaw : []).map((t: any) => ({
        id: `lastfm-${mbid || resolvedName}-${t.name}`,
        title: t.name,
        playCount: parseInt(t.playcount || "0"),
        listeners: parseInt(t.listeners || "0"),
        duration: parseInt(t.duration || "0"),
        url: t.url,
        album: { title: t.album?.["#text"] || "Unknown Album" },
    }));

    let image: string | null = fanartImage || deezerImage || null;
    if (!image && lastFmInfo?.image) {
        const images = normalizeToArray(lastFmInfo.image);
        const lastFmImage = lastFmService.getBestImage(images);
        if (
            lastFmImage &&
            !lastFmImage.includes("2a96cbd8b46e442fc41c2b86b821562f")
        ) {
            image = lastFmImage;
        }
    }
    if (existingCoverArt && !image) {
        image = existingCoverArt;
    } else if (existingCoverArt && image) {
        image = existingCoverArt;
    }

    const tags = normalizeToArray(lastFmInfo?.tags?.tag)
        .map((t: any) => t?.name)
        .filter(Boolean);

    const similarArtistsRaw = normalizeToArray(lastFmInfo?.similar?.artist);
    const similarArtists: JellyfinArtistEnrichment["similarArtists"] = await Promise.all(
        similarArtistsRaw.slice(0, 10).map(async (artist: any) => {
            const images = normalizeToArray(artist.image);
            const similarImage = images.find((img: any) => img.size === "large")?.["#text"];
            let img: string | null = null;
            if (artist.mbid) {
                try {
                    img = await fanartService.getArtistImage(artist.mbid);
                } catch {
                    // Ignore
                }
            }
            if (!img) {
                try {
                    img = await deezerService.getArtistImage(artist.name);
                } catch {
                    // Ignore
                }
            }
            if (!img && similarImage && !similarImage.includes("2a96cbd8b46e442fc41c2b86b821562f")) {
                img = similarImage;
            }
            return {
                id: artist.mbid || artist.name,
                name: artist.name,
                mbid: artist.mbid || null,
                url: artist.url,
                image: img,
            };
        })
    );

    let discoveryAlbums: JellyfinArtistEnrichment["discoveryAlbums"] = [];
    const releaseGroups = Array.isArray(releaseGroupsRaw) ? releaseGroupsRaw : [];
    if (releaseGroups.length > 0) {
        const filtered = releaseGroups.filter((rg: any) => {
                const isPrimary =
                    rg["primary-type"] === "Album" || rg["primary-type"] === "EP";
                if (!isPrimary) return false;
                const secondaryTypes = rg["secondary-types"] || [];
                const excluded = secondaryTypes.some((t: string) =>
                    ["Live", "Compilation", "Soundtrack", "Remix", "DJ-mix", "Mixtape/Street"].includes(t)
                );
                return !excluded;
            });

            discoveryAlbums = await Promise.all(
                filtered.map(async (rg: any) => {
                    let coverUrl = `https://coverartarchive.org/release-group/${rg.id}/front-500`;
                    const idx = filtered.indexOf(rg);
                    if (idx < 10) {
                        try {
                            const res = await fetch(coverUrl, {
                                method: "HEAD",
                                signal: AbortSignal.timeout(2000),
                            });
                            if (!res.ok) {
                                const dc = await deezerService.getAlbumCover(resolvedName, rg.title);
                                if (dc) coverUrl = dc;
                            }
                        } catch {
                            // Keep Cover Art Archive URL
                        }
                    }
                    return {
                        id: rg.id,
                        rgMbid: rg.id,
                        title: rg.title,
                        type: rg["primary-type"],
                        year: rg["first-release-date"]
                            ? parseInt(rg["first-release-date"].substring(0, 4))
                            : null,
                        coverUrl,
                        owned: false as const,
                    };
                })
            );
        discoveryAlbums.sort((a, b) => {
            if (a.year && b.year) return b.year - a.year;
            if (a.year) return -1;
            if (b.year) return 1;
            return 0;
        });
    }

    const result: JellyfinArtistEnrichment = {
        bio,
        image,
        genres: tags,
        listeners: parseInt(lastFmInfo?.stats?.listeners || "0"),
        playcount: parseInt(lastFmInfo?.stats?.playcount || "0"),
        topTracks,
        similarArtists,
        discoveryAlbums,
    };

    try {
        await redisClient.setEx(cacheKey, ENRICHMENT_CACHE_TTL, JSON.stringify(result));
    } catch (err) {
        logger.debug("[JellyfinEnrichment] Redis set error:", err);
    }

    return result;
}
