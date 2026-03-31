export interface ArtistRef {
    name: string;
    id?: string;
    mbid?: string;
}

export interface AlbumRef {
    title: string;
    id?: string;
    coverArt?: string;
}

export interface AudioFeatures {
    bpm?: number | null;
    energy?: number | null;
    valence?: number | null;
    arousal?: number | null;
    danceability?: number | null;
    keyScale?: string | null;
    instrumentalness?: number | null;
    analysisMode?: string | null;
    moodHappy?: number | null;
    moodSad?: number | null;
    moodRelaxed?: number | null;
    moodAggressive?: number | null;
    moodParty?: number | null;
    moodAcoustic?: number | null;
    moodElectronic?: number | null;
}

export interface Track {
    id: string;
    title: string;
    artist: ArtistRef;
    albumArtist?: { name: string; id?: string };
    album: AlbumRef;
    duration: number;
    filePath?: string;
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
    audioFeatures?: AudioFeatures | null;
}

export interface Artist {
    id: string;
    name: string;
    mbid?: string;
    coverArt?: string;
    heroUrl?: string | null;
    albumCount?: number;
    trackCount?: number;
}

export interface Album {
    id: string;
    title: string;
    coverArt?: string;
    coverUrl?: string;
    year?: number;
    rgMbid?: string;
    artist?: ArtistRef;
}

export interface Playlist {
    id: string;
    name: string;
    description?: string | null;
    coverUrl?: string | null;
    trackCount?: number;
    isOwner?: boolean;
    isHidden?: boolean;
}
