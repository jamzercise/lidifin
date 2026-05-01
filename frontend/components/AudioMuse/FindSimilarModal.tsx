"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Play, Loader2, Sparkles, ListPlus } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { CachedImage } from "@/components/ui/CachedImage";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
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
    album?: {
        id?: string;
        title: string;
        coverUrl?: string | null;
        coverArt?: string | null;
    };
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
    const [playlistName, setPlaylistName] = useState("");
    const playlistInputId = useId();
    const playlistInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!isOpen) {
            setShowSaveDialog(false);
            setPlaylistName("");
        }
    }, [isOpen]);

    useEffect(() => {
        if (isOpen && showSaveDialog) {
            playlistInputRef.current?.focus();
        }
    }, [isOpen, showSaveDialog]);

    useEffect(() => {
        if (isOpen && trackId) {
            setError(null);
            setTracks([]);
            setLoading(true);
            api.getAudioMuseSimilarTracks(trackId, 20)
                .then((res) => {
                    setTracks(res.tracks || []);
                    if (res.tracks?.length === 0 && !res.totalCount) {
                        setError(
                            "No similar tracks found. Ensure AudioMuse-AI has analyzed your library."
                        );
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

    const handleModalClose = () => {
        if (showSaveDialog) {
            setShowSaveDialog(false);
            setPlaylistName("");
        } else {
            onClose();
        }
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={handleModalClose}
            title={
                showSaveDialog
                    ? "Save to Playlist"
                    : `Similar to ${trackTitle || "this track"}`
            }
            subtitle={
                !showSaveDialog && artistName ? artistName : undefined
            }
            titleLeading={
                !showSaveDialog ? (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center shrink-0">
                        <Sparkles
                            className="w-5 h-5 text-white"
                            aria-hidden="true"
                        />
                    </div>
                ) : undefined
            }
            backdropClassName="bg-black/80"
            className="max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden rounded-2xl border-white/10 bg-[#1a1a1a] bg-none shadow-2xl"
            contentClassName={
                showSaveDialog
                    ? undefined
                    : "flex-1 min-h-0 overflow-y-auto -mr-1 pr-1"
            }
            footer={
                showSaveDialog ? (
                    <>
                        <Button
                            variant="secondary"
                            onClick={() => {
                                setShowSaveDialog(false);
                                setPlaylistName("");
                            }}
                        >
                            Cancel
                        </Button>
                        <Button
                            variant="secondary"
                            className="bg-purple-500 hover:bg-purple-600 text-white border-0"
                            onClick={handleSaveToPlaylist}
                            disabled={!playlistName.trim() || saving}
                            isLoading={saving}
                        >
                            Save
                        </Button>
                    </>
                ) : null
            }
        >
            {showSaveDialog ? (
                <>
                    <label
                        htmlFor={playlistInputId}
                        className="sr-only"
                    >
                        Playlist name
                    </label>
                    <input
                        ref={playlistInputRef}
                        id={playlistInputId}
                        type="text"
                        value={playlistName}
                        onChange={(e) => setPlaylistName(e.target.value)}
                        placeholder="Playlist name"
                        className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500"
                    />
                </>
            ) : loading ? (
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
                    <div className="flex gap-2 mb-4 flex-wrap">
                        <button
                            type="button"
                            onClick={handlePlay}
                            className="flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white font-medium hover:opacity-90 transition-opacity"
                        >
                            <Play className="w-4 h-4 fill-current" />
                            Play All
                        </button>
                        <button
                            type="button"
                            onClick={() => setShowSaveDialog(true)}
                            className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 text-white hover:bg-white/20 transition-colors"
                        >
                            <ListPlus className="w-4 h-4" />
                            Save to Playlist
                        </button>
                    </div>

                    <div className="space-y-2">
                        {tracks.map((track) => (
                            <div
                                key={track.id}
                                className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5"
                            >
                                <div className="relative w-10 h-10 rounded overflow-hidden bg-[#282828] shrink-0">
                                    {track.album?.coverUrl ??
                                    track.album?.coverArt ? (
                                        <CachedImage
                                            src={api.getCoverArtUrl(
                                                (track.album?.coverUrl ??
                                                    track.album?.coverArt)!,
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
        </Modal>
    );
}
