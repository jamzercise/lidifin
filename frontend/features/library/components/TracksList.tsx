"use client";

import { useState, memo, useCallback } from "react";
import { Track } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { PlaylistSelector } from "@/components/ui/PlaylistSelector";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import { AudioLines, Heart, ListPlus, Plus, Trash2, Play, Sparkles, Radio } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { api } from "@/lib/api";
import { useAudioState } from "@/lib/audio-state-context";
import { FindSimilarModal } from "@/components/AudioMuse/FindSimilarModal";
import { useSongRadio } from "@/hooks/useSongRadio";

interface TracksListProps {
    tracks: Track[];
    onPlay: (tracks: Track[], startIndex?: number) => void;
    onAddToQueue: (track: Track) => void;
    onAddToPlaylist: (playlistId: string, trackId: string) => void;
    onDelete: (trackId: string, trackTitle: string) => void;
    isLoading?: boolean;
    /** When set, show heart for Jellyfin tracks and call on toggle (add/remove favorite). */
    favoriteIds?: Set<string>;
    onToggleFavorite?: (trackId: string, isFavorite: boolean) => void;
    /** Hide delete button (e.g. on Favorites page). */
    hideDelete?: boolean;
    /** Show "Find similar" for Jellyfin tracks (AudioMuse-AI). Default true. */
    showFindSimilar?: boolean;
}

interface TrackRowProps {
    track: Track;
    index: number;
    isCurrentlyPlaying: boolean;
    onPlayTrack: () => void;
    onAddToQueue: (track: Track) => void;
    onShowAddToPlaylist: (trackId: string) => void;
    onFindSimilar?: (trackId: string, trackTitle: string, artistName?: string) => void;
    onStartRadio?: (track: Track) => void;
    isStartingRadio?: boolean;
    onDelete: (trackId: string, trackTitle: string) => void;
    favoriteIds?: Set<string>;
    onToggleFavorite?: (trackId: string, isFavorite: boolean) => void;
    hideDelete?: boolean;
}

const TrackRow = memo(
    function TrackRow({
        track,
        index,
        isCurrentlyPlaying,
        onPlayTrack,
        onAddToQueue,
        onShowAddToPlaylist,
        onFindSimilar,
        onStartRadio,
        isStartingRadio,
        onDelete,
        favoriteIds,
        onToggleFavorite,
        hideDelete,
    }: TrackRowProps) {
        const isJellyfin = track.id.startsWith("jellyfin:");
        const isFavorite = favoriteIds?.has(track.id) ?? false;
        return (
            <div
                key={track.id}
                onClick={onPlayTrack}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className={cn(
                    "grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                    isCurrentlyPlaying && "bg-white/5",
                )}
            >
                {/* Track number / Play icon */}
                <div className="w-8 flex items-center justify-center">
                    <span
                        className={cn(
                            "text-sm group-hover:hidden",
                            isCurrentlyPlaying ? "text-[#B1D2C3]" : (
                                "text-gray-500"
                            ),
                        )}
                    >
                        {isCurrentlyPlaying ?
                            <AudioLines className="w-4 h-4 text-[#B1D2C3]" />
                        :   index + 1}
                    </span>
                    <Play className="w-4 h-4 text-white hidden group-hover:block fill-current" />
                </div>

                {/* Cover + Title/Artist */}
                <div className="flex items-center gap-3 min-w-0">
                    <div className="relative w-10 h-10 bg-[#282828] rounded flex items-center justify-center overflow-hidden shrink-0">
                        {track.album?.coverArt ?
                            <CachedImage
                                src={api.getCoverArtUrl(
                                    track.album.coverArt,
                                    80,
                                )}
                                alt={track.title}
                                fill
                                sizes="40px"
                                className="object-cover"
                            />
                        :   <AudioLines className="w-4 h-4 text-gray-600" />}
                    </div>
                    <div className="min-w-0">
                        <h3
                            className={cn(
                                "text-sm font-medium truncate",
                                isCurrentlyPlaying ? "text-[#B1D2C3]" : (
                                    "text-white"
                                ),
                            )}
                        >
                            {track.displayTitle ?? track.title}
                        </h3>
                        <p className="text-xs text-gray-400 truncate">
                            {track.album?.artist?.name}
                        </p>
                    </div>
                </div>

                {/* Album - hidden on mobile */}
                <div className="hidden md:block min-w-0">
                    <p className="text-sm text-gray-400 truncate">
                        {track.album?.title}
                    </p>
                </div>

                {/* Actions + Duration */}
                <div className="flex items-center gap-1">
                    {isJellyfin && onToggleFavorite && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleFavorite(track.id, !isFavorite);
                            }}
                            className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity",
                                isFavorite
                                    ? "text-red-400 hover:text-red-300 hover:bg-white/10"
                                    : "text-gray-400 hover:text-white hover:bg-white/10",
                            )}
                            title={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
                        >
                            <Heart
                                className={cn("w-4 h-4", isFavorite && "fill-current")}
                            />
                        </button>
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onAddToQueue(track);
                        }}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Add to Queue"
                    >
                        <ListPlus className="w-4 h-4" />
                    </button>
                    {isJellyfin && onFindSimilar && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onFindSimilar(track.id, track.displayTitle ?? track.title, track.album?.artist?.name);
                            }}
                            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-purple-400 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Find similar"
                        >
                            <Sparkles className="w-4 h-4" />
                        </button>
                    )}
                    {isJellyfin && onStartRadio && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onStartRadio(track);
                            }}
                            disabled={isStartingRadio}
                            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                            title="Start song radio"
                            aria-label="Start a song radio from this track"
                        >
                            <Radio className="w-4 h-4" />
                        </button>
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onShowAddToPlaylist(track.id);
                        }}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                        title="Add to Playlist"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                    {!hideDelete && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete(track.id, track.title);
                            }}
                            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="Delete Track"
                        >
                            <Trash2 className="w-4 h-4" />
                        </button>
                    )}
                    <span className="text-xs text-gray-500 w-10 text-right">
                        {formatTime(track.duration)}
                    </span>
                </div>
            </div>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.track.id === nextProps.track.id &&
            prevProps.isCurrentlyPlaying === nextProps.isCurrentlyPlaying &&
            prevProps.index === nextProps.index &&
            prevProps.favoriteIds?.has(prevProps.track.id) ===
                nextProps.favoriteIds?.has(nextProps.track.id) &&
            prevProps.hideDelete === nextProps.hideDelete &&
            prevProps.onFindSimilar === nextProps.onFindSimilar &&
            prevProps.onStartRadio === nextProps.onStartRadio &&
            prevProps.isStartingRadio === nextProps.isStartingRadio
        );
    },
);

export function TracksList({
    tracks,
    onPlay,
    onAddToQueue,
    onAddToPlaylist,
    onDelete,
    isLoading = false,
    favoriteIds,
    onToggleFavorite,
    hideDelete,
    showFindSimilar = true,
}: TracksListProps) {
    const { currentTrack } = useAudioState();
    const { startRadio, startingId } = useSongRadio();
    const currentTrackId = currentTrack?.id;
    const [showPlaylistSelector, setShowPlaylistSelector] = useState(false);
    const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
    const [findSimilarTrack, setFindSimilarTrack] = useState<{
        id: string;
        title: string;
        artist?: string;
    } | null>(null);

    const handleShowAddToPlaylist = useCallback((trackId: string) => {
        setSelectedTrackId(trackId);
        setShowPlaylistSelector(true);
    }, []);

    const handleAddToPlaylist = useCallback(
        async (playlistId: string) => {
            if (!selectedTrackId) return;
            onAddToPlaylist(playlistId, selectedTrackId);
            setShowPlaylistSelector(false);
            setSelectedTrackId(null);
        },
        [selectedTrackId, onAddToPlaylist],
    );

    const handleFindSimilar = useCallback(
        (trackId: string, trackTitle: string, artistName?: string) => {
            setFindSimilarTrack({ id: trackId, title: trackTitle, artist: artistName });
        },
        [],
    );

    const handleStartRadio = useCallback(
        (track: Track) => {
            startRadio({
                id: track.id,
                title: track.displayTitle ?? track.title,
                artist: track.album?.artist
                    ? { name: track.album.artist.name, id: track.album.artist.id }
                    : undefined,
                album: track.album
                    ? {
                          title: track.album.title,
                          id: track.album.id,
                          coverArt: track.album.coverArt,
                      }
                    : undefined,
                duration: track.duration,
            });
        },
        [startRadio],
    );

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (tracks.length === 0) {
        return (
            <EmptyState
                icon={<AudioLines className="w-12 h-12" />}
                title="No songs yet"
                description="Your library is empty. Sync your music to get started."
            />
        );
    }

    return (
        <>
            {/* Header row */}
            <div className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-3 py-2 border-b border-white/10 text-xs text-gray-500 uppercase tracking-wider">
                <div className="w-8 text-center">#</div>
                <div>Title</div>
                <div className="hidden md:block">Album</div>
                <div className="w-[140px] text-right pr-2">Duration</div>
            </div>

            <div data-tv-section="library-tracks">
                {tracks.map((track, index) => {
                    const isCurrentlyPlaying = currentTrackId === track.id;
                    return (
                        <TrackRow
                            key={track.id}
                            track={track}
                            index={index}
                            isCurrentlyPlaying={isCurrentlyPlaying}
                            onPlayTrack={() => onPlay(tracks, index)}
                            onAddToQueue={onAddToQueue}
                            onShowAddToPlaylist={handleShowAddToPlaylist}
                            onFindSimilar={showFindSimilar ? handleFindSimilar : undefined}
                            onStartRadio={handleStartRadio}
                            isStartingRadio={startingId === track.id}
                            onDelete={onDelete}
                            favoriteIds={favoriteIds}
                            onToggleFavorite={onToggleFavorite}
                            hideDelete={hideDelete}
                        />
                    );
                })}
            </div>

            <PlaylistSelector
                isOpen={showPlaylistSelector}
                onClose={() => {
                    setShowPlaylistSelector(false);
                    setSelectedTrackId(null);
                }}
                onSelectPlaylist={handleAddToPlaylist}
            />
            {findSimilarTrack && (
                <FindSimilarModal
                    isOpen={!!findSimilarTrack}
                    onClose={() => setFindSimilarTrack(null)}
                    trackId={findSimilarTrack.id}
                    trackTitle={findSimilarTrack.title}
                    artistName={findSimilarTrack.artist}
                />
            )}
        </>
    );
}
