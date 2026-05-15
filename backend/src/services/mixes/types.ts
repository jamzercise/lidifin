/**
 * All `type` discriminants produced by mix generators and returned on the mixes API.
 * Kept as a const list so new generators must register their literal here (compile-time exhaustiveness).
 */
export const PROGRAMMATIC_MIX_TYPES = [
    "3am-thoughts",
    "acoustic",
    "artist-deep-dive",
    "artist-similar",
    "chill",
    "coffee-shop",
    "confidence-boost",
    "dance-floor",
    "deep-cuts",
    "discovery",
    "era",
    "focus-flow",
    "genre",
    "golden-hour",
    "happy",
    "hot-girl-walk",
    "in-my-feelings",
    "instrumental",
    "key-journey",
    "late-night",
    "main-character",
    "melancholy",
    "midnight-drive",
    "mood",
    "mood-on-demand",
    "rage-cleaning",
    "recently-added",
    "rediscover",
    "romanticize",
    "road-trip",
    "sad-girl-sundays",
    "shower-karaoke",
    "sunday-morning",
    "tempo-flow",
    "that-girl-era",
    "top-tracks",
    "unhinged",
    "villain-era",
    "vocal-detox",
    "workout",
] as const;

export type ProgrammaticMixType = (typeof PROGRAMMATIC_MIX_TYPES)[number];

export interface ProgrammaticMix {
    id: string;
    type: ProgrammaticMixType;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[];
    trackCount: number;
    color: string;
}

export type TrackWithAlbumCover = {
    id: string;
    album: {
        coverUrl: string | null;
        genres?: unknown;
        userGenres?: string[] | null;
        artist?: {
            userGenres?: string[] | null;
        };
    };
    lastfmTags?: string[];
    essentiaGenres?: string[];
    [key: string]: unknown;
};
