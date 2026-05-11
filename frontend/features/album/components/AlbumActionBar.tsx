import { Play, Pause, Shuffle, Download, ListPlus, Bookmark, BookmarkCheck, Loader2 } from "lucide-react";
import { cn } from "@/utils/cn";
import type { Album } from "../types";
import type { AlbumSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";

const LIDIFIN_ACCENT = "#B1D2C3";

interface AlbumActionBarProps {
    album: Album;
    source: AlbumSource;
    colors: ColorPalette | null;
    onPlayAll: () => void;
    onShuffle: () => void;
    onDownloadAlbum: () => void;
    onAddToPlaylist: () => void;
    isPendingDownload: boolean;
    isPlaying?: boolean;
    isPlayingThisAlbum?: boolean;
    onPause?: () => void;
    showSaveForLater?: boolean;
    savedForLater?: boolean;
    saveForLaterBusy?: boolean;
    onToggleSaveForLater?: () => void;
}

export function AlbumActionBar({
    album,
    source,
    colors: _colors,
    onPlayAll,
    onShuffle,
    onDownloadAlbum,
    onAddToPlaylist,
    isPendingDownload,
    isPlaying = false,
    isPlayingThisAlbum = false,
    onPause,
    showSaveForLater = false,
    savedForLater = false,
    saveForLaterBusy = false,
    onToggleSaveForLater,
}: AlbumActionBarProps) {
    const isOwned = album.owned !== undefined ? album.owned : source === "library";
    const showDownload = !isOwned && (album.mbid || album.rgMbid);
    const showPause = isPlaying && isPlayingThisAlbum;

    const handlePlayPauseClick = () => {
        if (showPause && onPause) {
            onPause();
        } else {
            onPlayAll();
        }
    };

    return (
        <div className="flex items-center gap-4">
            {/* Play Button - only for owned albums */}
            {isOwned && (
                <>
                    <button
                        onClick={handlePlayPauseClick}
                        className="h-12 w-12 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105"
                        style={{ backgroundColor: LIDIFIN_ACCENT }}
                    >
                        {showPause ? (
                            <Pause className="w-5 h-5 fill-current text-black" />
                        ) : (
                            <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                        )}
                    </button>

                    {/* Shuffle Button */}
                    <button
                        onClick={onShuffle}
                        className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title="Shuffle play"
                    >
                        <Shuffle className="w-5 h-5" />
                    </button>

                    {/* Add to Playlist Button */}
                    <button
                        onClick={onAddToPlaylist}
                        className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title="Add to playlist"
                    >
                        <ListPlus className="w-5 h-5" />
                    </button>
                </>
            )}

            {showSaveForLater && onToggleSaveForLater && (
                <button
                    type="button"
                    onClick={onToggleSaveForLater}
                    disabled={saveForLaterBusy}
                    className={cn(
                        "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium transition-all border",
                        savedForLater
                            ? "border-[#B1D2C3] bg-[#B1D2C3]/15 text-[#B1D2C3]"
                            : "border-white/20 text-white/80 hover:border-white/40 hover:text-white",
                        saveForLaterBusy && "opacity-50 cursor-wait"
                    )}
                    aria-label={
                        savedForLater
                            ? "Remove from saved albums"
                            : "Save album for later"
                    }
                >
                    {saveForLaterBusy ? (
                        <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden />
                    ) : savedForLater ? (
                        <BookmarkCheck className="w-4 h-4 shrink-0" aria-hidden />
                    ) : (
                        <Bookmark className="w-4 h-4 shrink-0" aria-hidden />
                    )}
                    <span>{savedForLater ? "Saved" : "Save for later"}</span>
                </button>
            )}

            {/* Download Album Button - prominent for unowned */}
            {showDownload && (
                <button
                    onClick={onDownloadAlbum}
                    disabled={isPendingDownload}
                    className={cn(
                        "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium transition-all",
                        isPendingDownload
                            ? "bg-white/5 text-white/50 cursor-not-allowed"
                            : "bg-[#B1D2C3] hover:bg-[#9bc4b3] text-black hover:scale-105"
                    )}
                >
                    <Download className="w-4 h-4" />
                    <span>
                        {isPendingDownload ? "Downloading..." : "Download"}
                    </span>
                </button>
            )}
        </div>
    );
}
