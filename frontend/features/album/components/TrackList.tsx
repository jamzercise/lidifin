import React, { memo, useCallback, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Play, Pause, Volume2, ListPlus, Plus, Heart, Sparkles } from "lucide-react";
import { cn } from "@/utils/cn";
import type { Track, Album, AlbumSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";
import { formatNumber } from "@/utils/formatNumber";
import { FindSimilarModal } from "@/components/AudioMuse/FindSimilarModal";

interface TrackListProps {
    tracks: Track[];
    album: Album;
    source: AlbumSource;
    currentTrackId: string | undefined;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track, index: number) => void;
    onAddToQueue: (track: Track) => void;
    onAddToPlaylist: (trackId: string) => void;
    previewTrack: string | null;
    previewPlaying: boolean;
    onPreview: (track: Track, e: React.MouseEvent) => void;
    /** Jellyfin favorites - show heart for Jellyfin tracks */
    favoriteIds?: Set<string>;
    onToggleFavorite?: (trackId: string, isFavorite: boolean) => void;
    /** Show "Find similar" for Jellyfin tracks. Default true. */
    showFindSimilar?: boolean;
}

interface TrackRowProps {
    track: Track;
    index: number;
    album: Album;
    isOwned: boolean;
    isPlaying: boolean;
    isPreviewPlaying: boolean;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track, index: number) => void;
    onAddToQueue: (track: Track) => void;
    onAddToPlaylist: (trackId: string) => void;
    onFindSimilar?: (trackId: string, trackTitle: string, artistName?: string) => void;
    onPreview: (track: Track, e: React.MouseEvent) => void;
    favoriteIds?: Set<string>;
    onToggleFavorite?: (trackId: string, isFavorite: boolean) => void;
}



const TrackRow = memo(
    function TrackRow({
        track,
        index,
        album,
        isOwned,
        isPlaying,
        isPreviewPlaying,
        colors,
        onPlayTrack,
        onAddToQueue,
        onAddToPlaylist,
        onFindSimilar,
        onPreview,
        favoriteIds,
        onToggleFavorite,
    }: TrackRowProps) {
        const isPreviewOnly = !isOwned;
        const isJellyfin = track.id.startsWith("jellyfin:");
        const isFavorite = favoriteIds?.has(track.id) ?? false;

        const handleAddToQueue = useCallback(
            (e: React.MouseEvent) => {
                e.stopPropagation();
                onAddToQueue(track);
            },
            [track, onAddToQueue]
        );

        const handleAddToPlaylist = useCallback(
            (e: React.MouseEvent) => {
                e.stopPropagation();
                onAddToPlaylist(track.id);
            },
            [track.id, onAddToPlaylist]
        );

        const handlePreview = useCallback(
            (e: React.MouseEvent) => {
                onPreview(track, e);
            },
            [track, onPreview]
        );

        const handlePlayTrack = useCallback(() => {
            onPlayTrack(track, index);
        }, [track, index, onPlayTrack]);

        const handleRowClick = useCallback(
            (e: React.MouseEvent) => {
                // For unowned tracks, play preview instead of local file
                if (isPreviewOnly) {
                    onPreview(track, e);
                } else {
                    onPlayTrack(track, index);
                }
            },
            [isPreviewOnly, track, index, onPlayTrack, onPreview]
        );

        return (
            <div
                data-track-row
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className={cn(
                    "group relative flex items-center gap-3 md:gap-4 px-3 md:px-4 py-3 hover:bg-[#141414] transition-colors cursor-pointer",
                    isPlaying && "bg-[#1a1a1a] border-l-2",
                    isPreviewOnly && "opacity-70 hover:opacity-90"
                )}
                style={
                    isPlaying
                        ? { borderLeftColor: colors?.vibrant || "#a855f7" }
                        : undefined
                }
                onClick={handleRowClick}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        if (isPreviewOnly) {
                            onPreview(track, e as unknown as React.MouseEvent);
                        } else {
                            handlePlayTrack();
                        }
                    }
                }}
            >
                <div className="w-6 md:w-8 flex-shrink-0 text-center">
                    <span
                        className={cn(
                            "group-hover:hidden text-sm",
                            isPlaying
                                ? "text-purple-400 font-bold"
                                : "text-gray-500"
                        )}
                    >
                        {index + 1}
                    </span>
                    <Play
                        className="hidden group-hover:inline-block w-4 h-4 text-white"
                        fill="currentColor"
                    />
                </div>

                <div className="flex-1 min-w-0">
                    <div
                        className={cn(
                            "font-medium truncate text-sm md:text-base flex items-center gap-2",
                            isPlaying ? "text-purple-400" : "text-white"
                        )}
                    >
                        <span className="truncate">
                            {track.displayTitle ?? track.title}
                        </span>
                        {isPreviewOnly && (
                            <span className="shrink-0 text-[10px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded border border-blue-500/30 font-medium">
                                PREVIEW
                            </span>
                        )}
                    </div>
                    {track.artist?.name &&
                        track.artist.name !== album.artist?.name && (
                            <div className="text-xs md:text-sm text-gray-400 truncate">
                                {track.artist.name}
                            </div>
                        )}
                </div>

                {isOwned &&
                    track.playCount !== undefined &&
                    track.playCount > 0 && (
                        <div className="hidden lg:flex items-center gap-1.5 text-xs text-gray-400 bg-[#1a1a1a] px-2 py-1 rounded-full">
                            <Play className="w-3 h-3" />
                            <span>{formatNumber(track.playCount)}</span>
                        </div>
                    )}

                {isOwned && (
                    <>
                        {isJellyfin && onToggleFavorite && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleFavorite(track.id, !isFavorite);
                                }}
                                className={cn(
                                    "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-2 hover:bg-[#2a2a2a] rounded-full transition-all",
                                    isFavorite
                                        ? "text-red-400 hover:text-red-300"
                                        : "text-gray-400 hover:text-white"
                                )}
                                aria-label={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
                                title={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
                            >
                                <Heart
                                    className={cn("w-4 h-4", isFavorite && "fill-current")}
                                />
                            </button>
                        )}
                        <button
                            onClick={handleAddToQueue}
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-2 hover:bg-[#2a2a2a] rounded-full transition-all text-gray-400 hover:text-white"
                            aria-label="Add to queue"
                            title="Add to queue"
                        >
                            <ListPlus className="w-4 h-4" />
                        </button>
                        {isJellyfin && onFindSimilar && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onFindSimilar(
                                        track.id,
                                        track.displayTitle ?? track.title,
                                        track.artist?.name ?? album.artist?.name
                                    );
                                }}
                                className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-2 hover:bg-[#2a2a2a] rounded-full transition-all text-gray-400 hover:text-purple-400"
                                aria-label="Find similar"
                                title="Find similar"
                            >
                                <Sparkles className="w-4 h-4" />
                            </button>
                        )}
                        <button
                            onClick={handleAddToPlaylist}
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-2 hover:bg-[#2a2a2a] rounded-full transition-all text-gray-400 hover:text-white"
                            aria-label="Add to playlist"
                            title="Add to playlist"
                        >
                            <Plus className="w-4 h-4" />
                        </button>
                    </>
                )}

                {isPreviewOnly && (
                    <button
                        onClick={handlePreview}
                        className="p-2 rounded-full bg-[#1a1a1a] hover:bg-[#2a2a2a] transition-colors text-white"
                        aria-label={
                            isPreviewPlaying ? "Pause preview" : "Play preview"
                        }
                    >
                        {isPreviewPlaying ? (
                            <Pause className="w-4 h-4" />
                        ) : (
                            <Volume2 className="w-4 h-4" />
                        )}
                    </button>
                )}

                {track.duration && (
                    <div className="text-xs md:text-sm text-gray-400 w-10 md:w-12 text-right tabular-nums">
                        {formatTime(track.duration)}
                    </div>
                )}
            </div>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.track.id === nextProps.track.id &&
            prevProps.isPlaying === nextProps.isPlaying &&
            prevProps.isPreviewPlaying === nextProps.isPreviewPlaying &&
            prevProps.index === nextProps.index &&
            prevProps.isOwned === nextProps.isOwned &&
            prevProps.favoriteIds?.has(prevProps.track.id) ===
                nextProps.favoriteIds?.has(nextProps.track.id) &&
            prevProps.onFindSimilar === nextProps.onFindSimilar
        );
    }
);

export const TrackList = memo(function TrackList({
    tracks,
    album,
    source,
    currentTrackId,
    colors,
    onPlayTrack,
    onAddToQueue,
    onAddToPlaylist,
    previewTrack,
    previewPlaying,
    onPreview,
    favoriteIds,
    onToggleFavorite,
    showFindSimilar = true,
}: TrackListProps) {
    const isOwned = source === "library";
    const [findSimilarTrack, setFindSimilarTrack] = useState<{
        id: string;
        title: string;
        artist?: string;
    } | null>(null);

    const handleFindSimilar = useCallback(
        (trackId: string, trackTitle: string, artistName?: string) => {
            setFindSimilarTrack({ id: trackId, title: trackTitle, artist: artistName });
        },
        [],
    );

    return (
        <section>
            <Card>
                <div
                    data-tv-section="tracks"
                    className="divide-y divide-[#1c1c1c]"
                >
                    {tracks.map((track, index) => {
                        const isPlaying = currentTrackId === track.id;
                        const isPreviewPlaying =
                            previewTrack === track.id && previewPlaying;

                        return (
                            <TrackRow
                                key={track.id}
                                track={track}
                                index={index}
                                album={album}
                                isOwned={isOwned}
                                isPlaying={isPlaying}
                                isPreviewPlaying={isPreviewPlaying}
                                colors={colors}
                                onPlayTrack={onPlayTrack}
                                onAddToQueue={onAddToQueue}
                                onAddToPlaylist={onAddToPlaylist}
                                onFindSimilar={showFindSimilar && isOwned ? handleFindSimilar : undefined}
                                onPreview={onPreview}
                                favoriteIds={favoriteIds}
                                onToggleFavorite={onToggleFavorite}
                            />
                        );
                    })}
                </div>
            </Card>
            {findSimilarTrack && (
                <FindSimilarModal
                    isOpen={!!findSimilarTrack}
                    onClose={() => setFindSimilarTrack(null)}
                    trackId={findSimilarTrack.id}
                    trackTitle={findSimilarTrack.title}
                    artistName={findSimilarTrack.artist}
                />
            )}
        </section>
    );
});
