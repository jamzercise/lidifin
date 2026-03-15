"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { usePlaylistsQuery } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { useAuth } from "@/lib/auth-context";
import { useAudioControls } from "@/lib/audio-context";
import { Play, Music, Eye, EyeOff, Pencil } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";

// Lidifin brand
const LIDIFY_YELLOW = "#B1D2C3";

interface PlaylistItem {
    id: string;
    track: {
        album?: {
            coverArt?: string;
        };
    };
}

interface Playlist {
    id: string;
    name: string;
    trackCount?: number;
    items?: PlaylistItem[];
    isOwner?: boolean;
    isHidden?: boolean;
    user?: {
        username: string;
    };
}

// Generate mosaic cover from playlist tracks, or generated cover when no track covers
function PlaylistMosaic({
    items,
    playlistId,
    size = 4,
    greyed = false,
}: {
    items?: PlaylistItem[];
    playlistId?: string;
    size?: number;
    greyed?: boolean;
}) {
    const coverUrls = useMemo(() => {
        if (!items || items.length === 0) return [];

        const tracksWithCovers = items.filter(
            (item) => item.track?.album?.coverArt
        );
        if (tracksWithCovers.length === 0) return [];

        // Get unique cover arts (up to 4)
        const uniqueCovers = Array.from(
            new Set(tracksWithCovers.map((item) => item.track.album!.coverArt))
        ).slice(0, size);

        return uniqueCovers.map((cover) => api.getCoverArtUrl(cover!, 200));
    }, [items, size]);

    // No track covers: use generated cover (same style as Made For You mixes)
    if (coverUrls.length === 0 && playlistId) {
        return (
            <Image
                src={api.getPlaylistCoverUrl(playlistId, 400)}
                alt=""
                fill
                className={cn("object-cover", greyed && "opacity-50")}
                sizes="400px"
                unoptimized
            />
        );
    }

    if (coverUrls.length === 0) {
        return (
            <div
                className={cn(
                    "w-full h-full flex items-center justify-center bg-gradient-to-br from-[#282828] to-[#181818]",
                    greyed && "opacity-50"
                )}
            >
                <Music className="w-10 h-10 text-gray-600" />
            </div>
        );
    }

    if (coverUrls.length === 1) {
        return (
            <Image
                src={coverUrls[0]}
                alt=""
                fill
                className={cn("object-cover", greyed && "opacity-50 grayscale")}
                sizes="200px"
                unoptimized
            />
        );
    }

    return (
        <div
            className={cn(
                "grid grid-cols-2 w-full h-full",
                greyed && "opacity-50 grayscale"
            )}
        >
            {coverUrls.slice(0, 4).map((url, index) => (
                <div key={index} className="relative">
                    <Image
                        src={url}
                        alt=""
                        fill
                        className="object-cover"
                        sizes="100px"
                        unoptimized
                    />
                </div>
            ))}
            {Array.from({ length: Math.max(0, 4 - coverUrls.length) }).map(
                (_, index) => (
                    <div
                        key={`empty-${index}`}
                        className="relative bg-[#282828] flex items-center justify-center"
                    >
                        <Music className="w-5 h-5 text-gray-600" />
                    </div>
                )
            )}
        </div>
    );
}

function PlaylistCard({
    playlist,
    index,
    onPlay,
    onToggleHide,
    onRename,
    isHiddenView = false,
    isEditing,
    editingName,
    onEditingNameChange,
    onStartEdit,
    onSaveEdit,
    onCancelEdit,
}: {
    playlist: Playlist;
    index: number;
    onPlay: (playlistId: string) => void;
    onToggleHide: (playlistId: string, hide: boolean) => void;
    onRename?: (playlistId: string, name: string) => void;
    isHiddenView?: boolean;
    isEditing?: boolean;
    editingName?: string;
    onEditingNameChange?: (name: string) => void;
    onStartEdit?: (playlistId: string) => void;
    onSaveEdit?: () => void;
    onCancelEdit?: () => void;
}) {
    const isShared = playlist.isOwner === false;
    const [isHiding, setIsHiding] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    const handleToggleHide = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsHiding(true);
        try {
            await onToggleHide(playlist.id, !playlist.isHidden);
        } finally {
            setIsHiding(false);
        }
    };

    const handleRenameClick = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onStartEdit?.(playlist.id);
    };

    return (
        <Link href={`/playlist/${playlist.id}`}>
            <div
                className={cn(
                    "group cursor-pointer p-3 rounded-md transition-colors hover:bg-white/5",
                    isHiddenView && "opacity-60 hover:opacity-100"
                )}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                {/* Cover Image */}
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                    <PlaylistMosaic
                        items={playlist.items}
                        playlistId={playlist.id}
                        greyed={isHiddenView}
                    />

                    {/* Hide/Unhide button for shared playlists */}
                    {isShared && (
                        <button
                            onClick={handleToggleHide}
                            disabled={isHiding}
                            className={cn(
                                "absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center",
                                "bg-black/60  transition-all duration-200",
                                "opacity-0 group-hover:opacity-100",
                                playlist.isHidden
                                    ? "text-green-400"
                                    : "text-gray-400",
                                isHiding && "opacity-50 cursor-not-allowed"
                            )}
                            title={
                                playlist.isHidden
                                    ? "Show playlist"
                                    : "Hide playlist"
                            }
                        >
                            {playlist.isHidden ? (
                                <Eye className="w-3.5 h-3.5" />
                            ) : (
                                <EyeOff className="w-3.5 h-3.5" />
                            )}
                        </button>
                    )}

                    {/* Play button overlay */}
                    <button
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onPlay(playlist.id);
                        }}
                        style={{ backgroundColor: LIDIFY_YELLOW }}
                        className={cn(
                            "absolute bottom-2 right-2 w-10 h-10 rounded-full flex items-center justify-center",
                            "shadow-lg shadow-black/40 transition-all duration-200",
                            "hover:scale-105 hover:brightness-110",
                            "opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0"
                        )}
                        title="Play playlist"
                    >
                        <Play className="w-4 h-4 fill-current ml-0.5 text-black" />
                    </button>
                </div>

                {/* Title and info */}
                <div
                    className="flex items-center gap-1.5 min-w-0"
                    onClick={(e) => isEditing && e.stopPropagation()}
                >
                    {isEditing ? (
                        <input
                            ref={inputRef}
                            type="text"
                            value={editingName ?? playlist.name}
                            onChange={(e) =>
                                onEditingNameChange?.(e.target.value)
                            }
                            onKeyDown={(e) => {
                                if (e.key === "Enter") onSaveEdit?.();
                                if (e.key === "Escape") onCancelEdit?.();
                            }}
                            onBlur={() => onSaveEdit?.()}
                            className="flex-1 min-w-0 text-sm font-semibold bg-white/10 text-white px-1.5 py-0.5 rounded border border-white/20 focus:outline-none focus:border-[#B1D2C3]"
                            onClick={(e) => e.stopPropagation()}
                        />
                    ) : (
                        <>
                            <h3
                                className={cn(
                                    "flex-1 min-w-0 text-sm font-semibold truncate",
                                    isHiddenView ? "text-gray-400" : "text-white"
                                )}
                            >
                                {playlist.name}
                            </h3>
                            {!isShared && onRename && (
                                <button
                                    onClick={handleRenameClick}
                                    className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all flex-shrink-0"
                                    title="Rename playlist"
                                >
                                    <Pencil className="w-3 h-3 text-white/50 hover:text-white" />
                                </button>
                            )}
                        </>
                    )}
                </div>
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {isShared && playlist.user?.username ? (
                        <span className="text-gray-500">
                            By {playlist.user.username} ·{" "}
                        </span>
                    ) : null}
                    {playlist.trackCount || 0}{" "}
                    {playlist.trackCount === 1 ? "song" : "songs"}
                </p>
            </div>
        </Link>
    );
}

export default function PlaylistsPage() {
    useRouter();
    useAuth();
    const { playTracks } = useAudioControls();
    const queryClient = useQueryClient();
    const [showHiddenTab, setShowHiddenTab] = useState(false);
    const [editingPlaylistId, setEditingPlaylistId] = useState<string | null>(
        null
    );
    const [editingName, setEditingName] = useState("");

    // Use React Query hook for playlists
    const { data: playlists = [], isLoading } = usePlaylistsQuery();

    // Separate visible and hidden playlists
    const { visiblePlaylists, hiddenPlaylists } = useMemo(() => {
        const visible: Playlist[] = [];
        const hidden: Playlist[] = [];

        playlists.forEach((p: Playlist) => {
            if (p.isHidden) {
                hidden.push(p);
            } else {
                visible.push(p);
            }
        });

        return { visiblePlaylists: visible, hiddenPlaylists: hidden };
    }, [playlists]);

    // Listen for playlist events and refetch immediately so name/track count stay in sync
    useEffect(() => {
        const handlePlaylistEvent = () => {
            queryClient.refetchQueries({ queryKey: queryKeys.playlists() });
        };

        window.addEventListener("playlist-created", handlePlaylistEvent);
        window.addEventListener("playlist-updated", handlePlaylistEvent);
        window.addEventListener("playlist-deleted", handlePlaylistEvent);

        return () => {
            window.removeEventListener("playlist-created", handlePlaylistEvent);
            window.removeEventListener("playlist-updated", handlePlaylistEvent);
            window.removeEventListener("playlist-deleted", handlePlaylistEvent);
        };
    }, [queryClient]);

    const handlePlayPlaylist = async (playlistId: string) => {
        try {
            const playlist = await api.getPlaylist(playlistId);
            if (playlist?.items && playlist.items.length > 0) {
                const tracks = playlist.items.map((item: { track: { id: string; title: string; duration: number; album?: { id?: string; title?: string; coverArt?: string; artist?: { id?: string; name?: string } } } }) => ({
                    id: item.track.id,
                    title: item.track.title,
                    artist: {
                        name: item.track.album?.artist?.name || "Unknown",
                        id: item.track.album?.artist?.id,
                    },
                    album: {
                        title: item.track.album?.title || "Unknown",
                        coverArt: item.track.album?.coverArt,
                        id: item.track.album?.id,
                    },
                    duration: item.track.duration,
                }));
                playTracks(tracks, 0);
            }
        } catch (error) {
            console.error("Failed to play playlist:", error);
        }
    };

    const handleToggleHide = async (playlistId: string, hide: boolean) => {
        try {
            if (hide) {
                await api.hidePlaylist(playlistId);
            } else {
                await api.unhidePlaylist(playlistId);
            }
            queryClient.refetchQueries({ queryKey: queryKeys.playlists() });
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );
        } catch (error) {
            console.error("Failed to toggle playlist visibility:", error);
        }
    };

    const handleRename = async (playlistId: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
            await api.updatePlaylist(playlistId, { name: trimmed });
            queryClient.refetchQueries({ queryKey: queryKeys.playlists() });
            window.dispatchEvent(
                new CustomEvent("playlist-updated", { detail: { playlistId } })
            );
        } catch (error) {
            console.error("Failed to rename playlist:", error);
        } finally {
            setEditingPlaylistId(null);
        }
    };

    const handleStartEdit = (playlistId: string) => {
        const p = playlists.find((x: Playlist) => x.id === playlistId);
        if (p) {
            setEditingPlaylistId(playlistId);
            setEditingName(p.name);
        }
    };

    const handleSaveEdit = () => {
        if (editingPlaylistId) {
            handleRename(editingPlaylistId, editingName);
        }
    };

    const handleCancelEdit = () => {
        setEditingPlaylistId(null);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    const displayedPlaylists = showHiddenTab
        ? hiddenPlaylists
        : visiblePlaylists;

    return (
        <div className="min-h-screen relative">
            {/* Quick gradient fade - yellow to purple */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-gradient-to-b from-[#B1D2C3]/15 via-purple-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#B1D2C3]/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            {/* Header */}
            <div className="relative px-6 pt-6 pb-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-white">
                            Playlists
                        </h1>
                        <p className="text-sm text-gray-400 mt-0.5">
                            {visiblePlaylists.length}{" "}
                            {visiblePlaylists.length === 1
                                ? "playlist"
                                : "playlists"}
                        </p>
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Browse Public Playlists */}
                        <Link
                            href="/browse/playlists"
                            className="px-4 py-2 rounded-full text-sm font-medium bg-[#B1D2C3] text-black hover:brightness-110 transition-all"
                        >
                            Browse Playlists
                        </Link>

                        {/* Hidden Playlists Toggle */}
                        {hiddenPlaylists.length > 0 && (
                            <button
                                onClick={() => setShowHiddenTab(!showHiddenTab)}
                                className={cn(
                                    "px-4 py-2 rounded-full text-sm font-medium transition-all",
                                    showHiddenTab
                                        ? "bg-white/10 text-white"
                                        : "bg-transparent text-gray-400 hover:text-white hover:bg-white/5"
                                )}
                            >
                                {showHiddenTab
                                    ? "Show All"
                                    : `Hidden (${hiddenPlaylists.length})`}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="relative px-4 pb-24">
                {/* Hidden playlists notice */}
                {showHiddenTab && (
                    <div className="mx-2 mb-4 px-4 py-3 bg-white/5 rounded-lg">
                        <p className="text-sm text-gray-400">
                            Hidden playlists won&apos;t appear in your library. Hover
                            and click the eye icon to restore.
                        </p>
                    </div>
                )}

                {displayedPlaylists.length > 0 ? (
                    <div
                        data-tv-section="playlists"
                        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-2"
                    >
                        {displayedPlaylists.map(
                            (playlist: Playlist, index: number) => (
                                <PlaylistCard
                                    key={playlist.id}
                                    playlist={playlist}
                                    index={index}
                                    onPlay={handlePlayPlaylist}
                                    onToggleHide={handleToggleHide}
                                    onRename={handleRename}
                                    isHiddenView={showHiddenTab}
                                    isEditing={
                                        editingPlaylistId === playlist.id
                                    }
                                    editingName={editingName}
                                    onEditingNameChange={setEditingName}
                                    onStartEdit={handleStartEdit}
                                    onSaveEdit={handleSaveEdit}
                                    onCancelEdit={handleCancelEdit}
                                />
                            )
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                            <Music className="w-8 h-8 text-gray-500" />
                        </div>
                        <h2 className="text-lg font-semibold text-white mb-1">
                            {showHiddenTab
                                ? "No hidden playlists"
                                : "No playlists yet"}
                        </h2>
                        <p className="text-sm text-gray-400 max-w-sm">
                            {showHiddenTab
                                ? "You haven't hidden any playlists"
                                : "Create your first playlist by adding songs from albums or artists"}
                        </p>
                        {!showHiddenTab && (
                            <Link
                                href="/browse/playlists"
                                className="mt-6 px-5 py-2.5 rounded-full text-sm font-medium bg-[#B1D2C3] text-black hover:brightness-110 transition-all"
                            >
                                Browse Playlists
                            </Link>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
