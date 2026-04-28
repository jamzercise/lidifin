"use client";

import { useEffect, useId, useState } from "react";
import { X, Play, Loader2, Sparkles, ListPlus } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { CachedImage } from "@/components/ui/CachedImage";
import { formatTime } from "@/utils/formatTime";
import { toast } from "sonner";

interface FindSimilarModalProps {
    isOpen: boolean;
    onClose: () => void;
    trackId: string;
    trackTitle?: string;
    artistName?: string;
}

interface ResolvedTrack {
    id: string;
    title: string;
    duration: number;
    artist?: { id?: string; name: string };
    album?: { id?: string; title: string; coverUrl?: string | null; coverArt?: string | null };
}

export function FindSimilarModal({
    isOpen,
    onClose,
    trackId,
    trackTitle,
    artistName,
}: FindSimilarModalProps) {
    const { playTracks } = useAudioControls();
    const [tracks, setTracks] = useState<ResolvedTrack[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const titleId = useId();
    const [playlistName, setPlaylistName] = useState("");

    useEffect(() => {
        if (isOpen && trackId) {
            setError(null);
            setTracks([]);
            setLoading(true);
            api.getAudioMuseSimilarTracks(trackId, 20)
                .then((res) => {
                    setTracks(res.tracks || []);
                    if (res.tracks?.length === 0 && !res.totalCount) {
                        setError("No similar tracks found. Ensure AudioMuse-AI has analyzed your library.");
                    }
                })
                .catch((err) => {
                    setError(err?.message || "Failed to find similar tracks");
                })
                .finally(() => setLoading(false));
        }
    }, [isOpen, trackId]);

    const handlePlay = () => {
        const mapped: Track[] = tracks.map((t) => ({
            id: t.id,
            title: t.title,
            artist: { name: t.artist?.name ?? "Unknown", id: t.artist?.id },
            album: {
                title: t.album?.title ?? "Unknown",
                coverArt: t.album?.coverArt ?? t.album?.coverUrl,
                id: t.album?.id,
            },
            duration: t.duration,
        }));
        playTracks(mapped, 0);
        toast.success("Playing similar tracks");
        onClose();
    };

    const handleSaveToPlaylist = async () => {
        if (!playlistName.trim()) return;
        setSaving(true);
        try {
            await api.saveAudioMusePlaylist(
                playlistName.trim(),
                tracks.map((t) => t.id)
            );
            toast.success(`Playlist "${playlistName}" created`);
            setShowSaveDialog(false);
            setPlaylistName("");
            onClose();
            window.dispatchEvent(new CustomEvent("playlist-created"));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={onClose}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="bg-[#1a1a1a] rounded-2xl max-w-lg w-full max-h-[85vh] overflow-hidden border border-white/10 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="p-6 border-b border-white/10 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                            <Sparkles
                                className="w-5 h-5 text-white"
                                aria-hidden="true"
                            />
                        </div>
                        <div>
                            <h2
                                id={titleId}
                                className="text-lg font-bold text-white"
                            >
                                Similar to {trackTitle || "this track"}
                            </h2>
                            {artistName && (
                                <p className="text-sm text-gray-400">{artistName}</p>
                            )}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close similar tracks dialog"
                        className="p-2 rounded-full hover:bg-white/10 transition-colors"
                    >
                        <X className="w-5 h-5 text-gray-400" aria-hidden="true" />
                    </button>
                </div>

                <div className="p-4 overflow-y-auto max-h-[calc(85vh-140px)]">
                    {loading ? (
                        <div className="flex justify-center py-12">
                            <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
                        </div>
                    ) : error ? (
                        <p className="text-center text-gray-400 py-8">{error}</p>
                    ) : tracks.length === 0 ? (
                        <p className="text-center text-gray-400 py-8">
                            No similar tracks found
                        </p>
                    ) : (
                        <>
                            <div className="flex gap-2 mb-4">
                                <button
                                    onClick={handlePlay}
                                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white font-medium hover:opacity-90 transition-opacity"
                                >
                                    <Play className="w-4 h-4 fill-current" />
                                    Play All
                                </button>
                                <button
                                    onClick={() => setShowSaveDialog(true)}
                                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
                                >
                                    <ListPlus className="w-4 h-4" />
                                    Save to Playlist
                                </button>
                            </div>

                            <div className="space-y-2">
                                {tracks.map((track, i) => (
                                    <div
                                        key={track.id}
                                        className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5"
                                    >
                                        <div className="relative w-10 h-10 rounded overflow-hidden bg-[#282828] shrink-0">
                                            {(track.album?.coverUrl ?? track.album?.coverArt) ? (
                                                <CachedImage
                                                    src={api.getCoverArtUrl(
                                                        (track.album?.coverUrl ?? track.album?.coverArt)!,
                                                        80
                                                    )}
                                                    alt=""
                                                    fill
                                                    sizes="40px"
                                                    className="object-cover"
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center">
                                                    <Sparkles className="w-4 h-4 text-gray-600" />
                                                </div>
                                            )}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-medium text-white truncate">
                                                {track.title}
                                            </p>
                                            <p className="text-xs text-gray-400 truncate">
                                                {track.artist?.name}
                                            </p>
                                        </div>
                                        <span className="text-xs text-gray-500 shrink-0">
                                            {formatTime(track.duration)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </>
                    )}
                </div>

                {showSaveDialog && (
                    <div className="absolute inset-0 bg-black/80 flex items-center justify-center p-4 rounded-2xl">
                        <div className="bg-[#1a1a1a] rounded-xl p-6 w-full max-w-sm border border-white/10">
                            <h3 className="text-lg font-semibold text-white mb-2">
                                Save to Playlist
                            </h3>
                            <input
                                type="text"
                                value={playlistName}
                                onChange={(e) => setPlaylistName(e.target.value)}
                                placeholder="Playlist name"
                                className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 mb-4"
                                autoFocus
                            />
                            <div className="flex gap-2">
                                <button
                                    onClick={() => {
                                        setShowSaveDialog(false);
                                        setPlaylistName("");
                                    }}
                                    className="flex-1 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSaveToPlaylist}
                                    disabled={!playlistName.trim() || saving}
                                    className="flex-1 py-2 rounded-lg bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50"
                                >
                                    {saving ? "Saving..." : "Save"}
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
