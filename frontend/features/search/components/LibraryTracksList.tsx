"use client";

import { useState } from "react";
import { Play, Pause, Heart, Sparkles } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { toArtistRouteId, toAlbumRouteId } from "@/lib/route-ids";
import { usePrefetchArtist } from "@/hooks/useQueries";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import type { LibraryTrack } from "../types";
import { FindSimilarModal } from "@/components/AudioMuse/FindSimilarModal";

interface LibraryTracksListProps {
    tracks: LibraryTrack[];
    favoriteIds?: Set<string>;
    onToggleFavorite?: (trackId: string, isFavorite: boolean) => void;
}

export function LibraryTracksList({ tracks, favoriteIds, onToggleFavorite }: LibraryTracksListProps) {
    const { currentTrack } = useAudioState();
    const prefetchArtist = usePrefetchArtist();
    const [findSimilarTrack, setFindSimilarTrack] = useState<{
        id: string;
        title: string;
        artist?: string;
    } | null>(null);
    const { isPlaying } = useAudioPlayback();
    const { playTracks, pause, resume } = useAudioControls();

    if (!tracks || tracks.length === 0) {
        return null;
    }

    const handlePlayTrack = (track: LibraryTrack, index: number) => {
        // Format tracks for playback
        const formattedTracks = tracks.map((t) => ({
            id: t.id,
            title: t.title,
            displayTitle: t.displayTitle,
            duration: t.duration,
            artist: {
                id: t.album.artist.id,
                name: t.album.artist.name,
            },
            album: {
                id: t.album.id,
                title: t.album.title,
                coverArt: t.album.coverUrl,
            },
        }));

        if (currentTrack?.id === track.id) {
            // Toggle play/pause if clicking the same track
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
        } else {
            // Play from this track
            playTracks(formattedTracks, index);
        }
    };

    return (
        <div className="space-y-1">
            {tracks.slice(0, 10).map((track, index) => {
                const isCurrentTrack = currentTrack?.id === track.id;
                const isPlayingThis = isCurrentTrack && isPlaying;
                const isJellyfin = track.id.startsWith("jellyfin:");
                const isFavorite = favoriteIds?.has(track.id) ?? false;
                const coverUrl = track.album.coverUrl
                    ? api.getCoverArtUrl(track.album.coverUrl, 48)
                    : null;

                return (
                    <div
                        key={track.id}
                        className={cn(
                            "flex items-center gap-3 p-2 rounded-md group transition-colors",
                            isCurrentTrack ? "bg-white/10" : "hover:bg-white/5"
                        )}
                    >
                        {/* Play Button / Track Number */}
                        <button
                            onClick={() => handlePlayTrack(track, index)}
                            className="w-8 h-8 flex items-center justify-center flex-shrink-0"
                        >
                            {isPlayingThis ? (
                                <Pause className="w-4 h-4 text-[#ecb200]" />
                            ) : isCurrentTrack ? (
                                <Play className="w-4 h-4 text-[#ecb200] ml-0.5" />
                            ) : (
                                <>
                                    <span className="text-sm text-gray-400 group-hover:hidden">
                                        {index + 1}
                                    </span>
                                    <Play className="w-4 h-4 text-white hidden group-hover:block ml-0.5" />
                                </>
                            )}
                        </button>

                        {/* Cover Art */}
                        <div className="w-10 h-10 bg-[#282828] rounded overflow-hidden flex-shrink-0">
                            {coverUrl ? (
                                <Image
                                    src={coverUrl}
                                    alt={track.album.title}
                                    width={40}
                                    height={40}
                                    className="object-cover w-full h-full"
                                    unoptimized
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <span className="text-gray-500 text-xs">
                                        ♪
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Track Info */}
                        <div className="flex-1 min-w-0">
                            <p
                                className={cn(
                                    "text-sm font-medium truncate",
                                    isCurrentTrack
                                        ? "text-[#ecb200]"
                                        : "text-white"
                                )}
                            >
                                {track.title}
                            </p>
                            <p className="text-xs text-gray-400 truncate">
                                <Link
                                    href={`/artist/${encodeURIComponent(toArtistRouteId(track.album.artist))}`}
                                    onMouseEnter={() => prefetchArtist(toArtistRouteId(track.album.artist), track.album.artist)}
                                    className="hover:underline hover:text-white"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {track.album.artist.name}
                                </Link>
                                <span className="mx-1">•</span>
                                <Link
                                    href={`/album/${encodeURIComponent(toAlbumRouteId(track.album))}`}
                                    className="hover:underline hover:text-white"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {track.album.title}
                                </Link>
                            </p>
                        </div>

                        {/* Find Similar + Favorite + Duration */}
                        {isJellyfin && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setFindSimilarTrack({
                                        id: track.id,
                                        title: track.title,
                                        artist: track.album.artist.name,
                                    });
                                }}
                                className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-purple-400 transition-all flex-shrink-0"
                                title="Find similar"
                                aria-label="Find similar"
                            >
                                <Sparkles className="w-4 h-4" />
                            </button>
                        )}
                        {isJellyfin && onToggleFavorite && (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onToggleFavorite(track.id, !isFavorite);
                                }}
                                className={cn(
                                    "p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all flex-shrink-0",
                                    isFavorite
                                        ? "text-red-400 hover:text-red-300"
                                        : "text-gray-400 hover:text-white"
                                )}
                                title={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
                                aria-label={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
                            >
                                <Heart
                                    className={cn("w-4 h-4", isFavorite && "fill-current")}
                                />
                            </button>
                        )}
                        <span className="text-sm text-gray-400 flex-shrink-0">
                            {formatTime(track.duration)}
                        </span>
                    </div>
                );
            })}
            {findSimilarTrack && (
                <FindSimilarModal
                    isOpen={!!findSimilarTrack}
                    onClose={() => setFindSimilarTrack(null)}
                    trackId={findSimilarTrack.id}
                    trackTitle={findSimilarTrack.title}
                    artistName={findSimilarTrack.artist}
                />
            )}
        </div>
    );
}
