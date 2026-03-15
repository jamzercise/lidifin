"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";
import { useAudioState, useAudioPlayback, useAudioControls, Track as AudioTrack } from "@/lib/audio-context";
import { cn } from "@/utils/cn";
import { shuffleArray } from "@/utils/shuffle";
import { formatTime } from "@/utils/formatTime";
import { usePlaylistQuery } from "@/hooks/useQueries";
import { useFavorites } from "@/hooks/useFavorites";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/lib/toast-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    Play,
    Pause,
    Trash2,
    Shuffle,
    Eye,
    EyeOff,
    Heart,
    ListPlus,
    ListMusic,
    Music,
    Volume2,
    RefreshCw,
    AlertCircle,
    X,
    Loader2,
    Pencil,
} from "lucide-react";

interface Track {
    id: string;
    title: string;
    duration: number;
    artist?: {
        id?: string;
        name: string;
    };
    album: {
        id?: string;
        title: string;
        coverArt?: string;
        artist?: {
            id?: string;
            name: string;
        };
    };
}

interface PlaylistItem {
    id: string;
    track: Track;
    type?: "track";
    sort?: number;
}

interface PendingTrack {
    id: string;
    type: "pending";
    sort: number;
    pending: {
        id: string;
        artist: string;
        title: string;
        album: string;
        previewUrl: string | null;
    };
}

export default function PlaylistDetailPage() {
    const params = useParams();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    // Use split hooks to avoid re-renders from currentTime updates
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, addToQueue, pause, resume } = useAudioControls();
    const { favoriteIds, addFavorite, removeFavorite } = useFavorites();
    const playlistId = params.id as string;

    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [isHiding, setIsHiding] = useState(false);
    const [isEditingName, setIsEditingName] = useState(false);
    const [editingName, setEditingName] = useState("");
    const nameInputRef = useRef<HTMLInputElement>(null);
    const [playingPreviewId, setPlayingPreviewId] = useState<string | null>(
        null
    );
    const [retryingTrackId, setRetryingTrackId] = useState<string | null>(null);
    const [removingTrackId, setRemovingTrackId] = useState<string | null>(null);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);

    // Clean up preview audio on unmount
    useEffect(() => {
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
            }
        };
    }, []);

    // Focus name input when editing
    useEffect(() => {
        if (isEditingName && nameInputRef.current) {
            nameInputRef.current.focus();
            nameInputRef.current.select();
        }
    }, [isEditingName]);

    // Handle Deezer preview playback
    const handlePlayPreview = async (pendingId: string) => {
        // If already playing this preview, stop it
        if (playingPreviewId === pendingId && previewAudioRef.current) {
            previewAudioRef.current.pause();
            setPlayingPreviewId(null);
            return;
        }

        // Stop any currently playing preview
        if (previewAudioRef.current) {
            previewAudioRef.current.pause();
        }

        // Show loading state
        setPlayingPreviewId(pendingId);

        try {
            // Always fetch a fresh preview URL since Deezer URLs expire quickly
            const result = await api.getFreshPreviewUrl(playlistId, pendingId);
            const previewUrl = result.previewUrl;

            // Create and play new audio
            const audio = new Audio(previewUrl);
            audio.volume = 0.5;
            audio.onended = () => setPlayingPreviewId(null);
            audio.onerror = (e) => {
                console.error("Deezer preview playback failed:", e);
                setPlayingPreviewId(null);
                toast.error("Preview playback failed");
            };
            previewAudioRef.current = audio;

            await audio.play();
        } catch (err) {
            console.error("Failed to play Deezer preview:", err);
            setPlayingPreviewId(null);
            toast.error("No preview available");
        }
    };

    // Handle retry download for pending track
    const handleRetryPendingTrack = async (pendingId: string) => {
        setRetryingTrackId(pendingId);
        try {
            const result = await api.retryPendingTrack(playlistId, pendingId);
            if (result.success) {
                // Use the activity sidebar (Active tab) instead of a toast/modal
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                // If the backend emits a scan/download notification, refresh it
                window.dispatchEvent(new CustomEvent("notifications-changed"));
                // Refresh playlist data after a delay to allow download + scan to complete
                setTimeout(() => {
                    queryClient.invalidateQueries({
                        queryKey: ["playlist", playlistId],
                    });
                }, 10000); // 10 seconds for download + scan
            } else {
                toast.error(result.message || "Track not found on Soulseek");
            }
        } catch (error) {
            console.error("Failed to retry download:", error);
            toast.error("Failed to retry download");
        } finally {
            setRetryingTrackId(null);
        }
    };

    // Handle remove pending track
    const handleRemovePendingTrack = async (pendingId: string) => {
        setRemovingTrackId(pendingId);
        try {
            await api.removePendingTrack(playlistId, pendingId);
            queryClient.invalidateQueries({
                queryKey: ["playlist", playlistId],
            });
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );
        } catch (error) {
            console.error("Failed to remove pending track:", error);
        } finally {
            setRemovingTrackId(null);
        }
    };

    // Use React Query hook for playlist
    const { data: playlist, isLoading } = usePlaylistQuery(playlistId);

    // Check if this is a shared playlist
    const isShared = playlist?.isOwner === false;

    const handleToggleHide = async () => {
        if (!playlist) return;
        setIsHiding(true);
        try {
            if (playlist.isHidden) {
                await api.unhidePlaylist(playlistId);
            } else {
                await api.hidePlaylist(playlistId);
            }

            // Update local state immediately
            queryClient.setQueryData(["playlist", playlistId], (old: Record<string, unknown>) => ({
                ...old,
                isHidden: !playlist.isHidden,
            }));

            // Dispatch event to update sidebar and other components
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );

            // Optionally navigate away if hiding
            if (!playlist.isHidden) {
                router.push("/playlists");
            }
        } catch (error) {
            console.error("Failed to toggle playlist visibility:", error);
        } finally {
            setIsHiding(false);
        }
    };

    // Calculate cover arts from playlist tracks for mosaic (memoized)
    const coverUrls = useMemo(() => {
        if (!playlist?.items || playlist.items.length === 0) return [];

        const tracksWithCovers = playlist.items.filter(
            (item: PlaylistItem) => item.track.album?.coverArt
        );
        if (tracksWithCovers.length === 0) return [];

        // Get unique cover arts (up to 4)
        const uniqueCovers = Array.from(
            new Set(tracksWithCovers.map((item) => item.track.album.coverArt))
        ).slice(0, 4);

        return uniqueCovers;
    }, [playlist]);

    const handleRemoveTrack = async (trackId: string) => {
        try {
            await api.removeTrackFromPlaylist(playlistId, trackId);
            // Invalidate single playlist and notify list/sidebar to refresh
            queryClient.invalidateQueries({ queryKey: ["playlist", playlistId] });
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );
        } catch (error) {
            console.error("Failed to remove track:", error);
        }
    };

    const handleDeletePlaylist = async () => {
        try {
            await api.deletePlaylist(playlistId);

            // Dispatch event to update sidebar
            window.dispatchEvent(
                new CustomEvent("playlist-deleted", { detail: { playlistId } })
            );

            router.push("/playlists");
        } catch (error) {
            console.error("Failed to delete playlist:", error);
        }
    };

    // Playable tracks (filter out items with null/unresolved track)
    const playableTracks = useMemo(() => {
        if (!playlist?.items) return [];
        return playlist.items.filter(
            (item: PlaylistItem) => item.track?.album?.artist
        );
    }, [playlist?.items]);

    // Check if this playlist is currently playing
    const playlistTrackIds = useMemo(() => {
        return new Set(
            playableTracks.map((item: PlaylistItem) => item.track.id)
        );
    }, [playableTracks]);

    const isThisPlaylistPlaying = useMemo(() => {
        if (!isPlaying || !currentTrack || !playlist?.items?.length)
            return false;
        // Check if current track is in this playlist
        return playlistTrackIds.has(currentTrack.id);
    }, [isPlaying, currentTrack, playlistTrackIds, playlist?.items?.length]);

    // Calculate total duration - MUST be before early returns
    const totalDuration = useMemo(() => {
        if (!playlist?.items) return 0;
        return playlist.items.reduce(
            (sum: number, item: PlaylistItem) =>
                sum + (item.track?.duration || 0),
            0
        );
    }, [playlist?.items]);

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    const handlePlayPlaylist = () => {
        if (!playlist?.items || playlist.items.length === 0) return;
        if (playableTracks.length === 0) {
            toast.error("No playable tracks in this playlist");
            return;
        }

        // If this playlist is playing, toggle pause/resume
        if (isThisPlaylistPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }

        const tracks = playableTracks.map((item: PlaylistItem) => ({
            id: item.track.id,
            title: item.track.title,
            artist: {
                name: item.track.album.artist?.name ?? "Unknown",
                id: item.track.album.artist?.id,
            },
            album: {
                title: item.track.album?.title ?? "Unknown",
                coverArt: item.track.album?.coverArt,
                id: item.track.album?.id,
            },
            duration: item.track.duration,
        }));
        playTracks(tracks, 0);
    };

    const handlePlayTrack = (indexInPlayable: number) => {
        if (playableTracks.length === 0) return;

        const tracks = playableTracks.map((item: PlaylistItem) => ({
                id: item.track.id,
                title: item.track.title,
                artist: {
                    name: item.track.album.artist?.name ?? "Unknown",
                    id: item.track.album.artist?.id,
                },
                album: {
                    title: item.track.album?.title ?? "Unknown",
                    coverArt: item.track.album?.coverArt,
                    id: item.track.album?.id,
                },
                duration: item.track.duration,
            }));
        playTracks(tracks, indexInPlayable);
    };

    const handleAddToQueue = (track: Track) => {
        if (!track?.album?.artist) return;
        const formattedTrack = {
            id: track.id,
            title: track.title,
            artist: {
                name: track.album.artist?.name ?? "Unknown",
                id: track.album.artist?.id,
            },
            album: {
                title: track.album?.title ?? "Unknown",
                coverArt: track.album?.coverArt,
                id: track.album?.id,
            },
            duration: track.duration,
        };
        addToQueue(formattedTrack);
    };


    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!playlist) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-gray-500">Playlist not found</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Compact Hero - Spotify Style */}
            <div className="relative bg-gradient-to-b from-[#3d2a1e] via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
                <div className="flex items-end gap-6">
                    {/* Cover Art */}
                    <div className="relative w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        {coverUrls && coverUrls.length > 0 ? (
                            <div className="grid grid-cols-2 gap-0 w-full h-full">
                                {coverUrls
                                    .slice(0, 4)
                                    .map(
                                        (
                                            url: string | undefined,
                                            index: number
                                        ) => {
                                            if (!url) return null;
                                            const proxiedUrl =
                                                api.getCoverArtUrl(url, 200);
                                            return (
                                                <div
                                                    key={index}
                                                    className="relative bg-[#181818]"
                                                >
                                                    <Image
                                                        src={proxiedUrl}
                                                        alt=""
                                                        fill
                                                        className="object-cover"
                                                        sizes="96px"
                                                        unoptimized
                                                    />
                                                </div>
                                            );
                                        }
                                    )}
                                {Array.from({
                                    length: Math.max(
                                        0,
                                        4 - (coverUrls?.length || 0)
                                    ),
                                }).map((_, index) => (
                                    <div
                                        key={`empty-${index}`}
                                        className="relative bg-[#282828]"
                                    />
                                ))}
                            </div>
                        ) : (
                            <Image
                                src={api.getPlaylistCoverUrl(playlistId, 400)}
                                alt=""
                                fill
                                className="object-cover"
                                sizes="192px"
                                unoptimized
                            />
                        )}
                    </div>

                    {/* Playlist Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">
                            {isShared ? "Public Playlist" : "Playlist"}
                        </p>
                        {!isShared && isEditingName ? (
                            <div className="flex items-center gap-2 mb-2">
                                <input
                                    ref={nameInputRef}
                                    type="text"
                                    value={editingName}
                                    onChange={(e) =>
                                        setEditingName(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter") {
                                            const trimmed =
                                                editingName.trim();
                                            if (trimmed) {
                                                api.updatePlaylist(
                                                    playlistId,
                                                    { name: trimmed }
                                                ).then(() => {
                                                    queryClient.setQueryData(
                                                        [
                                                            "playlist",
                                                            playlistId,
                                                        ],
                                                        (old: Record<string, unknown>) =>
                                                            old
                                                                ? {
                                                                      ...old,
                                                                      name: trimmed,
                                                                  }
                                                                : old
                                                    );
                                                    window.dispatchEvent(
                                                        new CustomEvent(
                                                            "playlist-updated",
                                                            {
                                                                detail: {
                                                                    playlistId,
                                                                },
                                                            }
                                                        )
                                                    );
                                                    setIsEditingName(false);
                                                });
                                            }
                                        }
                                        if (e.key === "Escape") {
                                            setEditingName(playlist.name);
                                            setIsEditingName(false);
                                        }
                                    }}
                                    onBlur={() => {
                                        const trimmed =
                                            editingName.trim();
                                        if (trimmed && trimmed !== playlist.name) {
                                            api.updatePlaylist(
                                                playlistId,
                                                { name: trimmed }
                                            ).then(() => {
                                                queryClient.setQueryData(
                                                    ["playlist", playlistId],
                                                    (old: Record<string, unknown>) =>
                                                        old
                                                            ? {
                                                                  ...old,
                                                                  name: trimmed,
                                                              }
                                                            : old
                                                );
                                                window.dispatchEvent(
                                                    new CustomEvent(
                                                        "playlist-updated",
                                                        {
                                                            detail: {
                                                                playlistId,
                                                            },
                                                        }
                                                    )
                                                );
                                            });
                                        }
                                        setIsEditingName(false);
                                    }}
                                    className="flex-1 min-w-0 text-2xl md:text-4xl lg:text-5xl font-bold text-white bg-white/10 px-2 py-1 rounded border border-white/20 focus:outline-none focus:border-[#B1D2C3]"
                                />
                            </div>
                        ) : (
                            <div className="flex items-center gap-2 mb-2 group/title">
                                <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2">
                                    {playlist.name}
                                </h1>
                                {!isShared && (
                                    <button
                                        onClick={() => {
                                            setEditingName(playlist.name);
                                            setIsEditingName(true);
                                        }}
                                        className="p-2 rounded opacity-0 group-hover/title:opacity-100 hover:bg-white/10 transition-all flex-shrink-0"
                                        title="Rename playlist"
                                    >
                                        <Pencil className="w-5 h-5 text-white/50 hover:text-white" />
                                    </button>
                                )}
                            </div>
                        )}
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            {isShared && playlist.user?.username && (
                                <>
                                    <span className="font-medium text-white">
                                        {playlist.user.username}
                                    </span>
                                    <span className="mx-1">•</span>
                                </>
                            )}
                            <span>{playlist.items?.length || 0} songs</span>
                            {totalDuration > 0 && (
                                <>
                                    <span>
                                        , {formatTotalDuration(totalDuration)}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {/* Play Button */}
                    {playlist.items && playlist.items.length > 0 && (
                        <button
                            onClick={handlePlayPlaylist}
                            disabled={playableTracks.length === 0}
                            title={playableTracks.length === 0 ? "No playable tracks" : "Play"}
                            className={cn(
                                "h-12 w-12 rounded-full flex items-center justify-center shadow-lg transition-all",
                                playableTracks.length > 0
                                    ? "bg-[#B1D2C3] hover:bg-[#9bc4b3] hover:scale-105"
                                    : "bg-gray-600 cursor-not-allowed opacity-60"
                            )}
                        >
                            {isThisPlaylistPlaying && isPlaying ? (
                                <Pause className="w-5 h-5 fill-current text-black" />
                            ) : (
                                <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                            )}
                        </button>
                    )}

                    {/* Shuffle Button */}
                    {playlist.items && playlist.items.length > 1 && (
                        <button
                            onClick={() => {
                                if (
                                    !playlist?.items ||
                                    playlist.items.length === 0
                                )
                                    return;
                                const tracks: AudioTrack[] = playableTracks.map(
                                    (item: PlaylistItem) => ({
                                        id: item.track.id,
                                        title: item.track.title,
                                        artist: {
                                            name: item.track.album.artist?.name ?? "Unknown",
                                            id: item.track.album.artist?.id,
                                        },
                                        album: {
                                            title: item.track.album?.title ?? "Unknown",
                                            coverArt: item.track.album?.coverArt,
                                            id: item.track.album?.id,
                                        },
                                        duration: item.track.duration,
                                    })
                                );
                                // Shuffle the tracks
                                const shuffled = shuffleArray(tracks);
                                playTracks(shuffled, 0);
                            }}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Hide Button */}
                    <button
                        onClick={handleToggleHide}
                        disabled={isHiding}
                        className={cn(
                            "h-8 w-8 rounded-full flex items-center justify-center transition-all",
                            playlist.isHidden
                                ? "text-[#B1D2C3] hover:text-[#9bc4b3]"
                                : "text-white/40 hover:text-white",
                            isHiding && "opacity-50 cursor-not-allowed"
                        )}
                        title={
                            playlist.isHidden
                                ? "Show playlist"
                                : "Hide playlist"
                        }
                    >
                        {playlist.isHidden ? (
                            <Eye className="w-5 h-5" />
                        ) : (
                            <EyeOff className="w-5 h-5" />
                        )}
                    </button>

                    {/* Delete Button */}
                    {playlist.isOwner && (
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="h-8 w-8 rounded-full flex items-center justify-center text-white/40 hover:text-red-400 transition-all"
                            title="Delete Playlist"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-4 md:px-8 pb-32">
                {/* Show failed/pending count if any */}
                {playlist.pendingCount > 0 && (
                    <div className="mb-4 px-4 py-2 bg-red-900/20 border border-red-500/30 rounded-lg flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 text-red-400" />
                        <span className="text-sm text-red-200">
                            {playlist.pendingCount} track
                            {playlist.pendingCount !== 1 ? "s" : ""} failed to
                            download - will auto-import when available
                        </span>
                    </div>
                )}

                {playlist.items?.length > 0 ||
                playlist.pendingTracks?.length > 0 ? (
                    <div className="w-full">
                        {/* Table Header */}
                        <div className="hidden md:grid grid-cols-[40px_minmax(160px,2fr)_minmax(100px,1fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Artist</span>
                            <span>Album</span>
                            <span className="text-right">Duration</span>
                        </div>

                        {/* Track Rows - use mergedItems to show tracks and pending in correct order */}
                        <div>
                            {(playlist.mergedItems || playlist.items || []).map(
                                (
                                    item: PlaylistItem | PendingTrack,
                                    index: number
                                ) => {
                                    // Handle pending/failed tracks
                                    if (item.type === "pending") {
                                        const pending = (item as PendingTrack)
                                            .pending;
                                        const isPreviewPlaying =
                                            playingPreviewId === pending.id;
                                        const isRetrying =
                                            retryingTrackId === pending.id;
                                        const isRemoving =
                                            removingTrackId === pending.id;

                                        return (
                                            <div
                                                key={`pending-${pending.id}`}
                                                className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(160px,2fr)_minmax(100px,1fr)_minmax(100px,1fr)_120px] gap-4 px-4 py-2 rounded-md opacity-60 hover:opacity-80 group transition-opacity"
                                            >
                                                {/* Track Number - failed icon */}
                                                <div className="flex items-center justify-center">
                                                    <AlertCircle className="w-4 h-4 text-red-400" />
                                                </div>

                                                {/* Title (mobile: title + artist subtitle) */}
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden flex items-center justify-center">
                                                        <button
                                                            onClick={() =>
                                                                handlePlayPreview(
                                                                    pending.id
                                                                )
                                                            }
                                                            className="w-full h-full flex items-center justify-center hover:bg-white/10 transition-colors"
                                                            title="Play 30s Deezer preview"
                                                        >
                                                            {isPreviewPlaying ? (
                                                                <Volume2 className="w-5 h-5 text-[#B1D2C3] animate-pulse" />
                                                            ) : (
                                                                <Play className="w-5 h-5 text-gray-400 hover:text-white" />
                                                            )}
                                                        </button>
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-medium truncate text-gray-400">
                                                            {pending.title}
                                                        </p>
                                                        <p className="text-xs text-gray-500 truncate md:hidden">
                                                            {pending.artist}
                                                        </p>
                                                    </div>
                                                </div>

                                                {/* Artist (hidden on mobile) */}
                                                <p className="hidden md:flex items-center text-sm text-gray-500 truncate">
                                                    {pending.artist}
                                                </p>

                                                {/* Album (hidden on mobile) */}
                                                <p className="hidden md:flex items-center text-sm text-gray-500 truncate">
                                                    {pending.album}
                                                </p>

                                                {/* Actions: Retry + Remove */}
                                                <div className="flex items-center justify-end gap-1">
                                                    <span className="text-xs text-red-400 mr-2 hidden sm:inline">
                                                        Failed
                                                    </span>
                                                    {/* Retry button */}
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRetryPendingTrack(
                                                                pending.id
                                                            );
                                                        }}
                                                        disabled={isRetrying}
                                                        className={cn(
                                                            "p-1.5 rounded-full hover:bg-white/10 transition-all",
                                                            isRetrying
                                                                ? "text-[#B1D2C3]"
                                                                : "text-gray-400 hover:text-white"
                                                        )}
                                                        title="Retry download"
                                                    >
                                                        {isRetrying ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                        ) : (
                                                            <RefreshCw className="w-4 h-4" />
                                                        )}
                                                    </button>
                                                    {/* Remove button */}
                                                    {playlist.isOwner && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleRemovePendingTrack(
                                                                    pending.id
                                                                );
                                                            }}
                                                            disabled={
                                                                isRemoving
                                                            }
                                                            className="p-1.5 rounded-full hover:bg-white/10 text-gray-400 hover:text-red-400 transition-all"
                                                            title="Remove from playlist"
                                                        >
                                                            {isRemoving ? (
                                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                                <X className="w-4 h-4" />
                                                            )}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    }

                                    // Handle regular tracks (or unresolved placeholder)
                                    const playlistItem = item as PlaylistItem;
                                    if (!playlistItem.track?.album?.artist) {
                                        return (
                                            <div
                                                key={playlistItem.id}
                                                className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 rounded-md opacity-50"
                                            >
                                                <div className="flex items-center justify-center">
                                                    <AlertCircle className="w-4 h-4 text-gray-500" />
                                                </div>
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="w-10 h-10 bg-[#282828] rounded shrink-0 flex items-center justify-center">
                                                        <Music className="w-5 h-5 text-gray-600" />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="text-sm text-gray-500 truncate">Track unavailable</p>
                                                        <p className="text-xs text-gray-600 truncate">May have been removed from library</p>
                                                    </div>
                                                </div>
                                                <p className="hidden md:flex items-center text-sm text-gray-500">—</p>
                                                <div />
                                            </div>
                                        );
                                    }
                                    const isCurrentlyPlaying =
                                        currentTrack?.id ===
                                        playlistItem.track.id;
                                    // Index in playable tracks (for correct playback order)
                                    const trackIndex =
                                        playableTracks.findIndex(
                                            (i: PlaylistItem) =>
                                                i.id === playlistItem.id
                                        );
                                    if (trackIndex < 0) return null;

                                    return (
                                        <div
                                            key={playlistItem.id}
                                            onClick={() =>
                                                handlePlayTrack(trackIndex)
                                            }
                                            className={cn(
                                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(160px,2fr)_minmax(100px,1fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                                                isCurrentlyPlaying &&
                                                    "bg-white/10"
                                            )}
                                        >
                                            {/* Track Number / Play Icon */}
                                            <div className="flex items-center justify-center">
                                                <span
                                                    className={cn(
                                                        "text-sm group-hover:hidden",
                                                        isCurrentlyPlaying
                                                            ? "text-[#B1D2C3]"
                                                            : "text-gray-400"
                                                    )}
                                                >
                                                    {isCurrentlyPlaying &&
                                                    isPlaying ? (
                                                        <Music className="w-4 h-4 text-[#B1D2C3] animate-pulse" />
                                                    ) : (
                                                        trackIndex + 1
                                                    )}
                                                </span>
                                                <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                            </div>

                                            {/* Title (mobile: title + artist subtitle) */}
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="relative w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                    {playlistItem.track.album
                                                        ?.coverArt ? (
                                                        <Image
                                                            src={api.getCoverArtUrl(
                                                                playlistItem
                                                                    .track.album
                                                                    .coverArt,
                                                                100
                                                            )}
                                                            alt={
                                                                playlistItem
                                                                    .track.title
                                                            }
                                                            fill
                                                            sizes="40px"
                                                            className="object-cover"
                                                            unoptimized
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Music className="w-5 h-5 text-gray-600" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="min-w-0 md:min-w-0">
                                                    <p
                                                        className={cn(
                                                            "text-sm font-medium truncate",
                                                            isCurrentlyPlaying
                                                                ? "text-[#B1D2C3]"
                                                                : "text-white"
                                                        )}
                                                    >
                                                        {
                                                            playlistItem.track
                                                                .title
                                                        }
                                                    </p>
                                                    {/* Artist subtitle - mobile only (desktop has dedicated column) */}
                                                    <p className="text-xs text-gray-400 truncate md:hidden">
                                                        {playlistItem.track?.artist?.name ??
                                                            playlistItem.track?.album?.artist?.name ??
                                                            "Unknown"}
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Artist (hidden on mobile) */}
                                            <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                                {playlistItem.track?.artist?.name ??
                                                    playlistItem.track?.album?.artist?.name ??
                                                    "Unknown"}
                                            </p>

                                            {/* Album (hidden on mobile) */}
                                            <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                                {playlistItem.track?.album?.title ?? "Unknown"}
                                            </p>

                                            {/* Duration + Actions */}
                                            <div className="flex items-center justify-end gap-2">
                                                {playlistItem.track.id.startsWith("jellyfin:") && (
                                                    <button
                                                        className={cn(
                                                            "p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all",
                                                            favoriteIds.has(playlistItem.track.id)
                                                                ? "text-red-400 hover:text-red-300"
                                                                : "text-gray-400 hover:text-white"
                                                        )}
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            const isFav = favoriteIds.has(playlistItem.track.id);
                                                            if (isFav) removeFavorite(playlistItem.track.id);
                                                            else addFavorite(playlistItem.track.id);
                                                        }}
                                                        title={favoriteIds.has(playlistItem.track.id) ? "Remove from Favorites" : "Add to Favorites"}
                                                    >
                                                        <Heart
                                                            className={cn("w-4 h-4", favoriteIds.has(playlistItem.track.id) && "fill-current")}
                                                        />
                                                    </button>
                                                )}
                                                <button
                                                    className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleAddToQueue(
                                                            playlistItem.track
                                                        );
                                                    }}
                                                    title="Add to Queue"
                                                >
                                                    <ListPlus className="w-4 h-4" />
                                                </button>
                                                <span className="text-sm text-gray-400 w-12 text-right">
                                                    {formatTime(
                                                        playlistItem.track
                                                            .duration
                                                    )}
                                                </span>
                                                {playlist.isOwner && (
                                                    <button
                                                        className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-red-400 transition-all"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRemoveTrack(
                                                                playlistItem
                                                                    .track.id
                                                            );
                                                        }}
                                                        title="Remove from Playlist"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                }
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-[#282828] rounded-full flex items-center justify-center mb-4">
                            <ListMusic className="w-10 h-10 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">
                            No tracks yet
                        </h3>
                        <p className="text-sm text-gray-500">
                            Add some tracks to get started
                        </p>
                    </div>
                )}
            </div>

            {/* Confirm Dialog */}
            <ConfirmDialog
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleDeletePlaylist}
                title="Delete Playlist?"
                message={`Are you sure you want to delete "${playlist.name}"? This action cannot be undone.`}
                confirmText="Delete"
                cancelText="Cancel"
                variant="danger"
            />
        </div>
    );
}
