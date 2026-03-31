export type {
    AudiobookProgress,
    AudiobookChapter,
    AudiobookSeries,
} from "@/types/audiobook";
import type { Audiobook as BaseAudiobook, AudiobookChapter } from "@/types/audiobook";

export interface AudiobookMetaTags {
    tagGenre?: string;
    tagDate?: string;
    tagComment?: string;
    tagAlbum?: string;
}

export interface AudiobookAudioFile {
    metaTags?: AudiobookMetaTags;
}

export interface Audiobook extends BaseAudiobook {
    audioFiles?: AudiobookAudioFile[];
}

export interface AudiobookMetadata {
    narrator: string | null;
    genre: string | null;
    publishedYear: string | null;
    description: string | null;
}
