"use client";

import { useState, useEffect } from "react";
import { Play, ListPlus, Loader2, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { CachedImage } from "@/components/ui/CachedImage";
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
    artistName,
}: SongsFromSimilarArtistsProps) {
    const { playTracks } = useAudioControls();
    const [tracks, setTracks] = useState<ResolvedTrack[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [playlistName, setPlaylistName] = useState("");

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

            {showSaveDialog && (
                <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
                    <div
                        className="bg-[#1a1a1a] rounded-xl p-6 w-full max-w-sm border border-white/10"
                        onClick={(e) => e.stopPropagation()}
                    >
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
        </section>
    );
}
