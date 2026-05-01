"use client";

import { useState, useEffect, useId, useRef } from "react";
import { Play, ListPlus, Loader2, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { CachedImage } from "@/components/ui/CachedImage";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { formatTime } from "@/utils/formatTime";
import { toast } from "sonner";

interface SongsFromSimilarArtistsProps {
    artistId: string;
    artistName: string;
}

interface ResolvedTrack {
    id: string;
    title: string;
    duration: number;
    artist?: { id?: string; name: string };
    album?: { id?: string; title: string; coverUrl?: string | null; coverArt?: string | null };
}

export function SongsFromSimilarArtists({
    artistId,
    artistName: _artistName,
}: SongsFromSimilarArtistsProps) {
    const { playTracks } = useAudioControls();
    const [tracks, setTracks] = useState<ResolvedTrack[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [playlistName, setPlaylistName] = useState("");
    const playlistInputId = useId();
    const playlistInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (showSaveDialog) {
            playlistInputRef.current?.focus();
        }
    }, [showSaveDialog]);

    useEffect(() => {
        if (!artistId || !artistId.startsWith("jellyfin:")) return;

        let cancelled = false;
        setLoading(true);
        setError(null);

        (async () => {
            try {
                const artistsRes = await api.getAudioMuseSimilarArtists(artistId, 4);
                const artists = artistsRes.artists || [];
                if (artists.length === 0) {
                    setTracks([]);
                    return;
                }

                const allTracks: ResolvedTrack[] = [];
                for (const a of artists.slice(0, 3)) {
                    if (cancelled) return;
                    const id = a.id ?? a.name;
                    if (!id) continue;
                    try {
                        const tracksRes = await api.getAudioMuseArtistTracks(id);
                        const ts = tracksRes.tracks || [];
                        allTracks.push(...ts.slice(0, 4));
                    } catch {
                        // Skip artist if tracks fail
                    }
                }

                if (!cancelled) setTracks(allTracks.slice(0, 15));
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : "Failed to load");
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [artistId]);

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
        toast.success("Playing songs from similar artists");
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
            window.dispatchEvent(new CustomEvent("playlist-created"));
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save");
        } finally {
            setSaving(false);
        }
    };

    if (!artistId.startsWith("jellyfin:")) return null;
    if (loading) {
        return (
            <section>
                <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-purple-400" />
                    Songs from similar artists
                </h2>
                <div className="flex justify-center py-12">
                    <Loader2 className="w-8 h-8 animate-spin text-purple-400" />
                </div>
            </section>
        );
    }
    if (error || tracks.length === 0) return null;

    return (
        <section>
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-400" />
                Songs from similar artists
            </h2>
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
                {tracks.map((track) => (
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

            <Modal
                isOpen={showSaveDialog}
                onClose={() => {
                    setShowSaveDialog(false);
                    setPlaylistName("");
                }}
                title="Save to Playlist"
                backdropClassName="bg-black/80"
                className="max-w-sm w-full rounded-xl border-white/10 bg-[#1a1a1a] bg-none"
                footer={
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
                }
            >
                <label htmlFor={playlistInputId} className="sr-only">
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
            </Modal>
        </section>
    );
}
