export type Tab = "artists" | "albums" | "tracks";

export type { Artist, Album } from "@/types/music";

export interface Track {
    id: string;
    title: string;
    duration: number;
    trackNumber?: number;
    album?: {
        id: string;
        title: string;
        coverArt?: string;
        artist?: {
            id: string;
            name: string;
        };
    };
    displayTitle?: string | null;
    displayTrackNo?: number | null;
    hasUserOverrides?: boolean;
}

export interface DeleteDialogState {
    isOpen: boolean;
    type: "track" | "album" | "artist";
    id: string;
    title: string;
}
