"use client";

import { useCallback, useEffect, useState } from "react";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useFavorites } from "@/hooks/useFavorites";
import { TracksList } from "@/features/library/components/TracksList";
import { LibraryHeader } from "@/features/library/components/LibraryHeader";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { EmptyState } from "@/components/ui/EmptyState";
import { Heart, AudioLines, RefreshCw } from "lucide-react";
import { Track } from "@/features/library/types";

function mapFavoritesToTrack(
    t: { id: string; title: string; duration: number; artist?: { id: string; name: string }; album?: { id: string; title: string; coverArt?: string | null } }
): Track {
    return {
        id: t.id,
        title: t.title,
        duration: t.duration,
        album: t.album
            ? {
                  id: t.album.id,
                  title: t.album.title,
                  coverArt: t.album.coverArt ?? undefined,
                  artist: t.artist ? { id: t.artist.id, name: t.artist.name } : undefined,
              }
            : undefined,
    };
}

export default function FavoritesPage() {
    const { tracks, isLoading, error, favoriteIds, addFavorite, removeFavorite, refetch } = useFavorites();
    const [isRefreshing, setIsRefreshing] = useState(false);
    const { playTracks, addToQueue } = useAudioControls();

    const libraryTracks: Track[] = tracks.map(mapFavoritesToTrack);

    const formatTracksForAudio = useCallback((libraryTracks: Track[]) => {
        return libraryTracks.map((track) => ({
            id: track.id,
            title: track.title,
            duration: track.duration,
            artist: {
                id: track.album?.artist?.id ?? "",
                name: track.album?.artist?.name ?? "Unknown Artist",
            },
            album: {
                id: track.album?.id ?? "",
                title: track.album?.title ?? "Unknown Album",
                coverArt: track.album?.coverArt,
            },
        }));
    }, []);

    const handlePlay = useCallback(
        (list: Track[], startIndex?: number) => {
            const formatted = formatTracksForAudio(list);
            playTracks(formatted, startIndex ?? 0);
        },
        [formatTracksForAudio, playTracks],
    );

    const handleAddToQueue = useCallback(
        (track: Track) => {
            addToQueue({
                id: track.id,
                title: track.title,
                duration: track.duration,
                artist: {
                    id: track.album?.artist?.id ?? "",
                    name: track.album?.artist?.name ?? "Unknown Artist",
                },
                album: {
                    id: track.album?.id ?? "",
                    title: track.album?.title ?? "Unknown Album",
                    coverArt: track.album?.coverArt,
                },
            });
        },
        [addToQueue],
    );

    const handleToggleFavorite = useCallback(
        (trackId: string, isFavorite: boolean) => {
            if (isFavorite) addFavorite(trackId);
            else removeFavorite(trackId);
        },
        [addFavorite, removeFavorite],
    );

    const noopDelete = useCallback(() => {}, []);
    const noopAddToPlaylist = useCallback(() => {}, []);

    const handleRefresh = useCallback(async () => {
        setIsRefreshing(true);
        try {
            await refetch();
        } finally {
            setIsRefreshing(false);
        }
    }, [refetch]);

    // Light auto-refresh: refetch when this page is opened or when user switches back to the tab
    useEffect(() => {
        refetch();
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") refetch();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    }, [refetch]);

    return (
        <div className="min-h-screen">
            <LibraryHeader
                eyebrow="Your Music"
                icon={<Heart className="w-4 h-4" />}
                title="Favorites"
                subtitle={
                    libraryTracks.length > 0
                        ? `${libraryTracks.length.toLocaleString()} ${
                              libraryTracks.length === 1
                                  ? "favorite"
                                  : "favorites"
                          }`
                        : "Jellyfin favorites — play or remove from list"
                }
                accent="rose"
                actions={
                    <button
                        onClick={handleRefresh}
                        disabled={isRefreshing}
                        className="flex items-center justify-center w-8 h-8 rounded-full bg-white/5 text-gray-400 hover:text-white hover:bg-white/10 transition-all disabled:opacity-50"
                        title="Refresh favorites from Jellyfin"
                    >
                        <RefreshCw className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`} />
                    </button>
                }
            />

            {error && (
                <div className="mx-4 mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400">
                    {error}
                </div>
            )}

            {isLoading ? (
                <div className="flex justify-center min-h-[300px] items-center">
                    <GradientSpinner size="lg" />
                </div>
            ) : libraryTracks.length === 0 ? (
                <EmptyState
                    icon={<Heart className="w-12 h-12 text-gray-500" />}
                    title="No favorites yet"
                    description="Add tracks to favorites from the Library (heart icon on Jellyfin tracks) to see them here."
                />
            ) : (
                <TracksList
                    tracks={libraryTracks}
                    onPlay={handlePlay}
                    onAddToQueue={handleAddToQueue}
                    onAddToPlaylist={noopAddToPlaylist}
                    onDelete={noopDelete}
                    favoriteIds={favoriteIds}
                    onToggleFavorite={handleToggleFavorite}
                    hideDelete
                />
            )}
        </div>
    );
}
