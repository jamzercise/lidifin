"use client";

import { useState, useCallback, useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, Search, Plus, Minus, Loader2, Play, ListPlus, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { CachedImage } from "@/components/ui/CachedImage";
import { Modal } from "@/components/ui/Modal";
import { formatTime } from "@/utils/formatTime";
import { cn } from "@/utils/cn";
import { toast } from "sonner";

interface AlchemyItem {
    id: string;
    op: "ADD" | "SUBTRACT";
    type: "song" | "artist";
    label: string;
    sublabel?: string;
}

interface ResolvedTrack {
    id: string;
    title: string;
    duration: number;
    artist?: { id?: string; name: string };
    album?: { id?: string; title: string; coverUrl?: string | null; coverArt?: string | null };
}

export default function SongAlchemyPage() {
    const { playTracks } = useAudioControls();
    const [searchQuery, setSearchQuery] = useState("");
    const [searchResults, setSearchResults] = useState<{
        tracks: Array<{ id: string; title: string; artist?: { name: string }; album?: { title: string } }>;
        artists: Array<{ id: string; name: string }>;
    }>({ tracks: [], artists: [] });
    const [searching, setSearching] = useState(false);
    const [items, setItems] = useState<AlchemyItem[]>([]);
    const [generating, setGenerating] = useState(false);
    const [tracks, setTracks] = useState<ResolvedTrack[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [playlistName, setPlaylistName] = useState("");

    const doSearch = useCallback(async (q: string) => {
        if (!q.trim() || q.length < 2) {
            setSearchResults({ tracks: [], artists: [] });
            return;
        }
        setSearching(true);
        try {
            const res = await api.search(q.trim(), "all", 15);
            const data = res as { tracks?: Array<{ id: string; title: string; artist?: { name: string }; album?: { title: string } }>; artists?: Array<{ id: string; name: string }> };
            const tracks = (data.tracks || []).filter((t) => t.id?.startsWith("jellyfin:"));
            const artists = (data.artists || []).filter((a) => a.id?.startsWith("jellyfin:"));
            setSearchResults({ tracks, artists });
        } catch {
            setSearchResults({ tracks: [], artists: [] });
        } finally {
            setSearching(false);
        }
    }, []);

    useEffect(() => {
        const t = setTimeout(() => doSearch(searchQuery), 300);
        return () => clearTimeout(t);
    }, [searchQuery, doSearch]);

    const addItem = (id: string, op: "ADD" | "SUBTRACT", type: "song" | "artist", label: string, sublabel?: string) => {
        setItems((prev) => {
            const exists = prev.find((i) => i.id === id && i.op === op);
            if (exists) return prev;
            return [...prev, { id, op, type, label, sublabel }];
        });
    };

    const removeItem = (id: string, op: "ADD" | "SUBTRACT") => {
        setItems((prev) => prev.filter((i) => !(i.id === id && i.op === op)));
    };

    const handleGenerate = async () => {
        const addItems = items.filter((i) => i.op === "ADD");
        if (addItems.length === 0) {
            toast.error("Add at least one item to mix");
            return;
        }
        setGenerating(true);
        setError(null);
        try {
            const res = await api.getAudioMuseAlchemy({
                items: items.map((i) => ({ id: i.id, op: i.op, type: i.type })),
                n: 30,
            });
            setTracks(res.tracks || []);
            if ((res.tracks?.length ?? 0) === 0) {
                setError("No results. Ensure AudioMuse-AI has analyzed your library.");
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to generate");
            setTracks([]);
        } finally {
            setGenerating(false);
        }
    };

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
        toast.success("Playing alchemy mix");
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

    return (
        <div className="min-h-screen px-4 md:px-8 py-6">
            <Link
                href="/vibe"
                className="inline-flex items-center gap-2 text-gray-400 hover:text-white mb-6 transition-colors"
            >
                <ArrowLeft className="w-4 h-4" />
                Back to Vibe
            </Link>

            <div className="flex items-center gap-3 mb-8">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                    <Sparkles className="w-6 h-6 text-white" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold text-white">Song Alchemy</h1>
                    <p className="text-sm text-gray-400">
                        Mix songs and artists with ADD/SUBTRACT to create a custom playlist
                    </p>
                </div>
            </div>

            {/* Search */}
            <div className="relative mb-6">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500" />
                <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search tracks or artists..."
                    className="w-full pl-10 pr-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500/50"
                />
                {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 animate-spin" />
                )}
            </div>

            {/* Search results */}
            {searchQuery.length >= 2 && (
                <div className="mb-6 p-4 rounded-xl bg-white/5 border border-white/10">
                    <h2 className="text-sm font-medium text-gray-400 mb-3">Add to mix</h2>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                        {searchResults.tracks.map((t) => (
                            <div
                                key={t.id}
                                className="flex items-center justify-between gap-2 py-2"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-white truncate">{t.title}</p>
                                    <p className="text-xs text-gray-400 truncate">
                                        {t.artist?.name} • {t.album?.title}
                                    </p>
                                </div>
                                <div className="flex gap-1 shrink-0">
                                    <button
                                        onClick={() =>
                                            addItem(t.id, "ADD", "song", t.title, t.artist?.name)
                                        }
                                        className="p-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30"
                                        title="Add"
                                    >
                                        <Plus className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() =>
                                            addItem(t.id, "SUBTRACT", "song", t.title, t.artist?.name)
                                        }
                                        className="p-1.5 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30"
                                        title="Subtract"
                                    >
                                        <Minus className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        ))}
                        {searchResults.artists.map((a) => (
                            <div
                                key={a.id}
                                className="flex items-center justify-between gap-2 py-2"
                            >
                                <p className="text-sm font-medium text-white truncate">{a.name}</p>
                                <div className="flex gap-1 shrink-0">
                                    <button
                                        onClick={() => addItem(a.id, "ADD", "artist", a.name)}
                                        className="p-1.5 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30"
                                        title="Add"
                                    >
                                        <Plus className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => addItem(a.id, "SUBTRACT", "artist", a.name)}
                                        className="p-1.5 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30"
                                        title="Subtract"
                                    >
                                        <Minus className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        ))}
                        {!searching &&
                            searchResults.tracks.length === 0 &&
                            searchResults.artists.length === 0 &&
                            searchQuery.length >= 2 && (
                                <p className="text-sm text-gray-500 py-2">
                                    No Jellyfin tracks or artists found
                                </p>
                            )}
                    </div>
                </div>
            )}

            {/* Ingredients */}
            {items.length > 0 && (
                <div className="mb-6 p-4 rounded-xl bg-white/5 border border-white/10">
                    <h3 className="text-sm font-medium text-gray-400 mb-3">Ingredients</h3>
                    <div className="flex flex-wrap gap-2">
                        {items.map((i) => (
                            <span
                                key={`${i.id}-${i.op}`}
                                className={cn(
                                    "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm",
                                    i.op === "ADD"
                                        ? "bg-green-500/20 text-green-400"
                                        : "bg-red-500/20 text-red-400"
                                )}
                            >
                                {i.op === "ADD" ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                                <span className="truncate max-w-[120px]">{i.label}</span>
                                <button
                                    onClick={() => removeItem(i.id, i.op)}
                                    className="hover:opacity-80"
                                >
                                    ×
                                </button>
                            </span>
                        ))}
                    </div>
                    <button
                        onClick={handleGenerate}
                        disabled={generating || items.filter((i) => i.op === "ADD").length === 0}
                        className="mt-4 flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white font-medium hover:opacity-90 disabled:opacity-50"
                    >
                        {generating ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Sparkles className="w-4 h-4" />
                        )}
                        Generate
                    </button>
                </div>
            )}

            {/* Results */}
            {(tracks.length > 0 || error) && (
                <div className="mt-8">
                    <h2 className="text-xl font-bold text-white mb-4">Results</h2>
                    {error && <p className="text-gray-400 mb-4">{error}</p>}
                    {tracks.length > 0 && (
                        <>
                            <div className="flex gap-2 mb-4">
                                <button
                                    onClick={handlePlay}
                                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-purple-500 to-pink-500 text-white font-medium hover:opacity-90"
                                >
                                    <Play className="w-4 h-4 fill-current" />
                                    Play All
                                </button>
                                <button
                                    onClick={() => setShowSaveDialog(true)}
                                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 text-white hover:bg-white/20"
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
                        </>
                    )}
                </div>
            )}

            <Modal
                isOpen={showSaveDialog}
                onClose={() => {
                    setShowSaveDialog(false);
                    setPlaylistName("");
                }}
                title="Save to Playlist"
                backdropClassName="bg-black/80"
                className="max-w-sm w-full rounded-xl border border-white/10 bg-[#1a1a1a]"
                contentClassName="space-y-4"
                footer={
                    <div className="flex w-full gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setShowSaveDialog(false);
                                setPlaylistName("");
                            }}
                            className="flex-1 py-2 rounded-lg bg-white/10 text-white hover:bg-white/20"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={handleSaveToPlaylist}
                            disabled={!playlistName.trim() || saving}
                            className="flex-1 py-2 rounded-lg bg-purple-500 text-white hover:bg-purple-600 disabled:opacity-50"
                        >
                            {saving ? "Saving..." : "Save"}
                        </button>
                    </div>
                }
            >
                <input
                    type="text"
                    value={playlistName}
                    onChange={(e) => setPlaylistName(e.target.value)}
                    placeholder="Playlist name"
                    className="w-full px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500"
                    autoFocus
                />
            </Modal>
        </div>
    );
}
