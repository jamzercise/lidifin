"use client";

import { useState, lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radio, Play, Loader2, Shuffle, ChevronLeft, Sparkles, Music2, Mic2 } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioState } from "@/lib/audio-context";
import { Track } from "@/lib/audio-state-context";
import { toast } from "sonner";
import { shuffleArray } from "@/utils/shuffle";
import { FindSimilarModal } from "@/components/AudioMuse/FindSimilarModal";

const MoodMixer = lazy(() => import("@/components/MoodMixer").then((mod) => ({ default: mod.MoodMixer })));

interface RadioStation {
    id: string;
    name: string;
    description: string;
    color: string;
    filter: {
        type: "genre" | "decade" | "discovery" | "favorites" | "all" | "workout" | "mood";
        value?: string;
    };
    minTracks?: number;
}

interface VibeCount {
    tag: string;
    count: number;
}

interface GenreCount {
    genre: string;
    count: number;
}

// Static radio stations
const STATIC_STATIONS: RadioStation[] = [
    {
        id: "all",
        name: "Shuffle All",
        description: "Your entire library",
        color: "from-brand/40 to-amber-600/30",
        filter: { type: "all" },
        minTracks: 10,
    },
    {
        id: "workout",
        name: "Workout",
        description: "High energy tracks",
        color: "from-red-500/30 to-orange-600/30",
        filter: { type: "workout" },
        minTracks: 15,
    },
    {
        id: "discovery",
        name: "Discovery",
        description: "Lesser-played gems",
        color: "from-emerald-500/30 to-teal-600/30",
        filter: { type: "discovery" },
        minTracks: 20,
    },
    {
        id: "favorites",
        name: "Favorites",
        description: "Most played",
        color: "from-rose-500/30 to-pink-600/30",
        filter: { type: "favorites" },
        minTracks: 10,
    },
];

interface DecadeCount {
    decade: number;
    count: number;
}

// Decade color mapping - covers from 1700s (classical) to 2020s
const DECADE_COLORS: Record<number, string> = {
    1700: "from-amber-800/30 to-yellow-900/30",
    1710: "from-amber-700/30 to-yellow-800/30",
    1720: "from-amber-700/30 to-yellow-800/30",
    1730: "from-amber-700/30 to-yellow-800/30",
    1740: "from-amber-700/30 to-yellow-800/30",
    1750: "from-amber-600/30 to-yellow-700/30",
    1760: "from-amber-600/30 to-yellow-700/30",
    1770: "from-amber-600/30 to-yellow-700/30",
    1780: "from-amber-600/30 to-yellow-700/30",
    1790: "from-amber-600/30 to-yellow-700/30",
    1800: "from-slate-600/30 to-gray-700/30",
    1810: "from-slate-600/30 to-gray-700/30",
    1820: "from-slate-500/30 to-gray-600/30",
    1830: "from-slate-500/30 to-gray-600/30",
    1840: "from-slate-500/30 to-gray-600/30",
    1850: "from-slate-400/30 to-gray-500/30",
    1860: "from-slate-400/30 to-gray-500/30",
    1870: "from-slate-400/30 to-gray-500/30",
    1880: "from-slate-400/30 to-gray-500/30",
    1890: "from-slate-400/30 to-gray-500/30",
    1900: "from-sepia-400/30 to-amber-500/30",
    1910: "from-amber-400/30 to-yellow-500/30",
    1920: "from-yellow-500/30 to-amber-600/30",
    1930: "from-orange-400/30 to-amber-500/30",
    1940: "from-red-400/30 to-orange-500/30",
    1950: "from-pink-400/30 to-red-500/30",
    1960: "from-amber-500/30 to-orange-600/30",
    1970: "from-orange-500/30 to-red-600/30",
    1980: "from-fuchsia-500/30 to-purple-600/30",
    1990: "from-purple-500/30 to-violet-600/30",
    2000: "from-blue-500/30 to-cyan-600/30",
    2010: "from-teal-500/30 to-emerald-600/30",
    2020: "from-orange-500/30 to-amber-600/30",
};

const getDecadeColor = (decade: number): string => {
    return DECADE_COLORS[decade] || "from-gray-500/30 to-slate-600/30";
};

const getDecadeName = (decade: number): string => {
    if (decade < 1900) return `${decade}s`;
    if (decade < 2000) return `${decade.toString().slice(2)}s`;
    return `${decade}s`;
};

const getDecadeDescription = (decade: number, count: number): string => {
    return `${decade}-${decade + 9} • ${count} tracks`;
};

// Genre color mapping
const GENRE_COLORS: Record<string, string> = {
    rock: "from-red-500/30 to-orange-600/30",
    pop: "from-pink-500/30 to-rose-600/30",
    "hip hop": "from-purple-500/30 to-indigo-600/30",
    "hip-hop": "from-purple-500/30 to-indigo-600/30",
    rap: "from-purple-500/30 to-indigo-600/30",
    electronic: "from-cyan-500/30 to-blue-600/30",
    jazz: "from-amber-500/30 to-yellow-600/30",
    classical: "from-slate-400/30 to-gray-500/30",
    metal: "from-zinc-600/30 to-neutral-700/30",
    country: "from-orange-400/30 to-amber-500/30",
    folk: "from-green-500/30 to-emerald-600/30",
    indie: "from-violet-500/30 to-purple-600/30",
    alternative: "from-indigo-500/30 to-blue-600/30",
    "r&b": "from-fuchsia-500/30 to-pink-600/30",
    soul: "from-amber-600/30 to-orange-700/30",
    blues: "from-blue-600/30 to-indigo-700/30",
    punk: "from-lime-500/30 to-green-600/30",
    reggae: "from-green-400/30 to-yellow-500/30",
    default: "from-gray-500/30 to-slate-600/30",
};

const getGenreColor = (genre: string): string => {
    const lower = genre.toLowerCase();
    return GENRE_COLORS[lower] || GENRE_COLORS.default;
};

// Preset vibe/mood stations (Last.fm tags + audio analysis)
const VIBE_STATIONS: RadioStation[] = [
    { id: "vibe-chill", name: "Chill", description: "Relaxing vibes", color: "from-teal-500/30 to-cyan-600/30", filter: { type: "mood", value: "chill" }, minTracks: 15 },
    { id: "vibe-energetic", name: "Energetic", description: "High energy", color: "from-orange-500/30 to-red-600/30", filter: { type: "mood", value: "energetic" }, minTracks: 15 },
    { id: "vibe-sad", name: "Sad", description: "Melancholy mood", color: "from-indigo-500/30 to-blue-600/30", filter: { type: "mood", value: "sad" }, minTracks: 15 },
    { id: "vibe-romantic", name: "Romantic", description: "Love songs", color: "from-rose-500/30 to-pink-600/30", filter: { type: "mood", value: "romantic" }, minTracks: 15 },
    { id: "vibe-study", name: "Study", description: "Focus music", color: "from-slate-500/30 to-gray-600/30", filter: { type: "mood", value: "study" }, minTracks: 15 },
    { id: "vibe-driving", name: "Driving", description: "Road trip vibes", color: "from-amber-500/30 to-orange-600/30", filter: { type: "mood", value: "driving" }, minTracks: 15 },
];

const getVibeColor = (tag: string): string => {
    const lower = tag.toLowerCase();
    return GENRE_COLORS[lower] || VIBE_STATIONS.find((s) => s.filter.value === lower)?.color || GENRE_COLORS.default;
};

// Radio Station Card Component
function RadioStationCard({ 
    station, 
    onPlay, 
    isLoading 
}: { 
    station: RadioStation; 
    onPlay: () => void; 
    isLoading: boolean;
}) {
    return (
        <button
            onClick={onPlay}
            disabled={isLoading}
            className={`
                relative group w-full
                aspect-[4/3] rounded-lg overflow-hidden
                bg-gradient-to-br ${station.color}
                border border-white/10 hover:border-white/20
                transition-all duration-200
                hover:scale-[1.02] active:scale-[0.98]
                disabled:opacity-50 disabled:cursor-not-allowed
            `}
        >
            {/* Content */}
            <div className="absolute inset-0 p-3 flex flex-col justify-between">
                <div className="flex items-center gap-1.5">
                    <Radio className="w-4 h-4 text-white/60" />
                    <span className="text-[10px] text-white/60 font-medium uppercase tracking-wider">
                        Radio
                    </span>
                </div>
                <div>
                    <h3 className="text-sm font-bold text-white truncate leading-tight">
                        {station.name}
                    </h3>
                    <p className="text-xs text-white/50 truncate">
                        {station.description}
                    </p>
                </div>
            </div>

            {/* Play overlay on hover */}
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                {isLoading ? (
                    <Loader2 className="w-8 h-8 text-white animate-spin" />
                ) : (
                    <div className="w-12 h-12 rounded-full bg-brand flex items-center justify-center shadow-lg">
                        <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                    </div>
                )}
            </div>
        </button>
    );
}

// Section Header Component
function SectionHeader({ title, description }: { title: string; description?: string }) {
    return (
        <div className="mb-4">
            <h2 className="text-xl font-bold text-white">{title}</h2>
            {description && <p className="text-sm text-white/50 mt-1">{description}</p>}
        </div>
    );
}

export default function RadioPage() {
    const { playTracks } = useAudioControls();
    const { currentTrack } = useAudioState();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);
    const [showMoodMixer, setShowMoodMixer] = useState(false);
    const [showSimilarSong, setShowSimilarSong] = useState(false);
    const [showArtistSimilarity, setShowArtistSimilarity] = useState(false);
    const [artistSearchQuery, setArtistSearchQuery] = useState("");
    const [artistSimilarityLoading, setArtistSimilarityLoading] = useState(false);

    // AudioMuse status for AI section
    const { data: audiomuseStatus } = useQuery({
        queryKey: ["audiomuse", "status"],
        queryFn: () => api.getAudioMuseStatus(),
        staleTime: 60 * 1000,
    });
    const audiomuseAvailable = audiomuseStatus?.enabled && audiomuseStatus?.available;

    // Fetch genres from library
    const { data: genresData, isLoading: genresLoading } = useQuery({
        queryKey: ["library", "genres"],
        queryFn: () => api.get<{ genres: GenreCount[] }>("/library/genres"),
        staleTime: 5 * 60 * 1000,
        select: (data) => (data.genres || []).filter((g) => g.count >= 15),
    });

    // Fetch decades from library
    const { data: decadesData, isLoading: decadesLoading } = useQuery({
        queryKey: ["library", "decades"],
        queryFn: () => api.get<{ decades: DecadeCount[] }>("/library/decades"),
        staleTime: 5 * 60 * 1000,
        select: (data) => data.decades || [],
    });

    // Fetch vibes (Last.fm mood tags) from library
    const { data: vibesData } = useQuery({
        queryKey: ["library", "vibes"],
        queryFn: () => api.get<{ vibes: VibeCount[] }>("/library/vibes"),
        staleTime: 60 * 60 * 1000, // 1 hour
        select: (data) => (data.vibes || []).filter((v) => v.count >= 15),
    });

    const genres = genresData ?? [];
    const decades = decadesData ?? [];
    const vibes = vibesData ?? [];
    const isLoading = genresLoading || decadesLoading;

    const startRadio = async (station: RadioStation) => {
        setLoadingStation(station.id);

        try {
            const params = new URLSearchParams();
            params.set("type", station.filter.type);
            if (station.filter.value) {
                params.set("value", station.filter.value);
            }
            params.set("limit", "50");

            const response = await api.get<{ tracks: Track[] }>(`/library/radio?${params.toString()}`);

            if (!response.tracks || response.tracks.length === 0) {
                toast.error(`No tracks found for ${station.name}`);
                return;
            }

            if (response.tracks.length < (station.minTracks || 10)) {
                toast.error(`Not enough tracks for ${station.name} radio`, {
                    description: `Found ${response.tracks.length}, need at least ${station.minTracks || 10}`,
                });
                return;
            }

            // Shuffle the tracks
            const shuffled = shuffleArray(response.tracks);

            // Start playing
            playTracks(shuffled, 0);
            toast.success(`${station.name} Radio`, {
                description: `Shuffling ${shuffled.length} tracks`,
                icon: <Shuffle className="w-4 h-4" />,
            });
        } catch (error) {
            console.error("Failed to start radio:", error);
            toast.error("Failed to start radio station");
        } finally {
            setLoadingStation(null);
        }
    };

    // Create genre stations from library
    const genreStations: RadioStation[] = genres.map((g) => ({
        id: `genre-${g.genre}`,
        name: g.genre,
        description: `${g.count} tracks`,
        color: getGenreColor(g.genre),
        filter: { type: "genre" as const, value: g.genre },
        minTracks: 15,
    }));

    // Create decade stations from library (dynamically based on what's available)
    const decadeStations: RadioStation[] = decades.map((d) => ({
        id: `decade-${d.decade}`,
        name: getDecadeName(d.decade),
        description: getDecadeDescription(d.decade, d.count),
        color: getDecadeColor(d.decade),
        filter: { type: "decade" as const, value: d.decade.toString() },
        minTracks: 15,
    }));

    // Create vibe stations from library (exclude tags already in preset VIBE_STATIONS)
    const presetVibeTags = new Set(VIBE_STATIONS.map((s) => s.filter.value?.toLowerCase()));
    const dynamicVibeStations: RadioStation[] = vibes
        .filter((v) => !presetVibeTags.has(v.tag.toLowerCase()))
        .map((v) => ({
            id: `vibe-${v.tag}`,
            name: v.tag.charAt(0).toUpperCase() + v.tag.slice(1),
            description: `${v.count} tracks`,
            color: getVibeColor(v.tag),
            filter: { type: "mood" as const, value: v.tag },
            minTracks: 15,
        }));

    const handleSimilarSongClick = () => {
        if (currentTrack?.id?.startsWith("jellyfin:")) {
            setShowSimilarSong(true);
        } else {
            toast.error("Play a track from your library first to find similar songs");
        }
    };

    const handleArtistSimilarityClick = async () => {
        const query = artistSearchQuery.trim();
        if (!query) {
            toast.error("Enter an artist name");
            return;
        }
        setArtistSimilarityLoading(true);
        try {
            const searchRes = await api.search(query, "artists", 5);
            const artists = (searchRes as { artists?: Array<{ id?: string; name?: string }> })?.artists ?? [];
            const libraryArtist = artists.find((a: { id?: string }) => a.id?.startsWith("jellyfin:"));
            const artistId = libraryArtist?.id ?? query;
            const artistName = libraryArtist?.name ?? query;

            const artistsRes = await api.getAudioMuseSimilarArtists(artistId, 4);
            const similarArtists = artistsRes.artists || [];
            if (similarArtists.length === 0) {
                toast.error("No similar artists found. Ensure AudioMuse-AI has analyzed your library.");
                return;
            }

            const allTracks: Track[] = [];
            for (const a of similarArtists.slice(0, 3)) {
                const id = (a as { id?: string | null; name: string }).id ?? (a as { artist?: string }).artist ?? (a as { name?: string }).name;
                if (!id) continue;
                try {
                    const tracksRes = await api.getAudioMuseArtistTracks(id);
                    const ts = tracksRes.tracks || [];
                    for (const tr of ts.slice(0, 4)) {
                        const t = tr as { id: string; title: string; duration: number; artist?: { name?: string; id?: string }; album?: { title?: string; coverArt?: string; coverUrl?: string; id?: string } };
                        allTracks.push({
                            id: t.id,
                            title: t.title,
                            duration: t.duration,
                            artist: { name: t.artist?.name ?? "Unknown", id: t.artist?.id },
                            album: {
                                title: t.album?.title ?? "Unknown",
                                coverArt: t.album?.coverArt ?? t.album?.coverUrl,
                                id: t.album?.id,
                            },
                        });
                    }
                } catch {
                    // Skip artist
                }
            }

            const tracksToPlay = allTracks.slice(0, 15);
            if (tracksToPlay.length === 0) {
                toast.error("No tracks found from similar artists");
                return;
            }
            playTracks(tracksToPlay, 0);
            toast.success(`Playing ${tracksToPlay.length} tracks from artists similar to ${artistName}`);
            setShowArtistSimilarity(false);
            setArtistSearchQuery("");
        } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to start artist similarity radio");
        } finally {
            setArtistSimilarityLoading(false);
        }
    };

    return (
        <div className="min-h-screen relative">
            {/* Hero gradient */}
            <div 
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background: "linear-gradient(to bottom, rgba(236, 178, 0, 0.15) 0%, rgba(139, 92, 246, 0.08) 40%, transparent 100%)",
                    height: "35vh"
                }}
            />
            <div 
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background: "radial-gradient(ellipse at top, rgba(236, 178, 0, 0.1) 0%, transparent 70%)",
                    height: "25vh"
                }}
            />

            {/* Content */}
            <div className="relative px-4 md:px-8 py-6">
                {/* Back link */}
                <Link 
                    href="/" 
                    className="inline-flex items-center gap-1 text-sm text-white/60 hover:text-white transition-colors mb-6"
                >
                    <ChevronLeft className="w-4 h-4" />
                    Back to Home
                </Link>

                {/* Header */}
                <div className="mb-8">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-brand to-amber-600 flex items-center justify-center">
                            <Radio className="w-6 h-6 text-black" />
                        </div>
                        <div>
                            <h1 className="text-3xl font-bold text-white">Radio Stations</h1>
                            <p className="text-white/60">Continuous shuffle from your library</p>
                        </div>
                    </div>
                </div>

                {/* Quick Start Section */}
                <section className="mb-10">
                    <SectionHeader 
                        title="Quick Start" 
                        description="Jump into your music instantly" 
                    />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                        {STATIC_STATIONS.map((station) => (
                            <RadioStationCard
                                key={station.id}
                                station={station}
                                onPlay={() => startRadio(station)}
                                isLoading={loadingStation === station.id}
                            />
                        ))}
                    </div>
                </section>

                {/* Vibes Section - Mood-based stations from Last.fm tags */}
                <section className="mb-10">
                    <SectionHeader 
                        title="By Vibe" 
                        description="Mood-based stations from your library" 
                    />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                        {VIBE_STATIONS.map((station) => (
                            <RadioStationCard
                                key={station.id}
                                station={station}
                                onPlay={() => startRadio(station)}
                                isLoading={loadingStation === station.id}
                            />
                        ))}
                        {dynamicVibeStations.map((station) => (
                            <RadioStationCard
                                key={station.id}
                                station={station}
                                onPlay={() => startRadio(station)}
                                isLoading={loadingStation === station.id}
                            />
                        ))}
                    </div>
                </section>

                {/* Genres Section */}
                {(isLoading || genreStations.length > 0) && (
                    <section className="mb-10">
                        <SectionHeader 
                            title="By Genre" 
                            description="Shuffle tracks from specific genres" 
                        />
                        {isLoading ? (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="aspect-[4/3] rounded-lg bg-white/5 animate-pulse" />
                                ))}
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {genreStations.map((station) => (
                                    <RadioStationCard
                                        key={station.id}
                                        station={station}
                                        onPlay={() => startRadio(station)}
                                        isLoading={loadingStation === station.id}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                )}

                {/* Decades Section - Only show if there are decade stations */}
                {(isLoading || decadeStations.length > 0) && (
                    <section className="mb-10">
                        <SectionHeader 
                            title="By Decade" 
                            description="Travel through time with your music" 
                        />
                        {isLoading ? (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="aspect-[4/3] rounded-lg bg-white/5 animate-pulse" />
                                ))}
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {decadeStations.map((station) => (
                                    <RadioStationCard
                                        key={station.id}
                                        station={station}
                                        onPlay={() => startRadio(station)}
                                        isLoading={loadingStation === station.id}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                )}

                {/* AI-Powered (AudioMuse) Section */}
                {audiomuseAvailable && (
                    <section className="mb-10">
                        <SectionHeader 
                            title="AI-Powered Radio" 
                            description="Instant Playlist, Similar Song, and Artist Similarity from AudioMuse-AI" 
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <button
                                onClick={() => setShowMoodMixer(true)}
                                className="relative group w-full aspect-[4/3] rounded-lg overflow-hidden bg-gradient-to-br from-violet-500/30 to-purple-600/30 border border-white/10 hover:border-white/20 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] text-left p-4 flex flex-col justify-between"
                            >
                                <div className="flex items-center gap-1.5">
                                    <Sparkles className="w-4 h-4 text-white/60" />
                                    <span className="text-[10px] text-white/60 font-medium uppercase tracking-wider">AI</span>
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-white truncate leading-tight">Instant Playlist</h3>
                                    <p className="text-xs text-white/50 truncate">Describe a mood or vibe in words</p>
                                </div>
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                    <div className="w-12 h-12 rounded-full bg-brand flex items-center justify-center shadow-lg">
                                        <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                                    </div>
                                </div>
                            </button>

                            <button
                                onClick={handleSimilarSongClick}
                                className="relative group w-full aspect-[4/3] rounded-lg overflow-hidden bg-gradient-to-br from-cyan-500/30 to-blue-600/30 border border-white/10 hover:border-white/20 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] text-left p-4 flex flex-col justify-between"
                            >
                                <div className="flex items-center gap-1.5">
                                    <Music2 className="w-4 h-4 text-white/60" />
                                    <span className="text-[10px] text-white/60 font-medium uppercase tracking-wider">AI</span>
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-white truncate leading-tight">Similar Song</h3>
                                    <p className="text-xs text-white/50 truncate">Play a track first, then find similar</p>
                                </div>
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                    <div className="w-12 h-12 rounded-full bg-brand flex items-center justify-center shadow-lg">
                                        <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                                    </div>
                                </div>
                            </button>

                            <button
                                onClick={() => setShowArtistSimilarity(true)}
                                className="relative group w-full aspect-[4/3] rounded-lg overflow-hidden bg-gradient-to-br from-amber-500/30 to-orange-600/30 border border-white/10 hover:border-white/20 transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] text-left p-4 flex flex-col justify-between"
                            >
                                <div className="flex items-center gap-1.5">
                                    <Mic2 className="w-4 h-4 text-white/60" />
                                    <span className="text-[10px] text-white/60 font-medium uppercase tracking-wider">AI</span>
                                </div>
                                <div>
                                    <h3 className="text-sm font-bold text-white truncate leading-tight">Artist Similarity</h3>
                                    <p className="text-xs text-white/50 truncate">Tracks from similar artists</p>
                                </div>
                                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                    <div className="w-12 h-12 rounded-full bg-brand flex items-center justify-center shadow-lg">
                                        <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                                    </div>
                                </div>
                            </button>
                        </div>

                        {/* Artist Similarity Modal */}
                        {showArtistSimilarity && (
                            <div
                                className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80"
                                role="dialog"
                                aria-modal="true"
                                aria-labelledby="artist-similarity-title"
                                aria-describedby="artist-similarity-desc"
                            >
                                <div className="bg-[#1a1a1a] rounded-xl p-6 max-w-md w-full border border-white/10 max-h-[90vh] overflow-y-auto">
                                    <h3 id="artist-similarity-title" className="text-lg font-bold text-white mb-2">Artist Similarity Radio</h3>
                                    <p id="artist-similarity-desc" className="text-sm text-white/60 mb-4">
                                        Enter an artist name from your library to play tracks from similar artists.
                                    </p>
                                    <input
                                        type="text"
                                        value={artistSearchQuery}
                                        onChange={(e) => setArtistSearchQuery(e.target.value)}
                                        onKeyDown={(e) => e.key === "Enter" && handleArtistSimilarityClick()}
                                        placeholder="e.g. Against Me!"
                                        aria-label="Artist name"
                                        aria-invalid={!artistSearchQuery.trim()}
                                        className="w-full px-4 py-3 rounded-lg bg-white/10 text-white placeholder-white/40 border border-white/20 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 mb-2"
                                        autoFocus
                                    />
                                    {!artistSearchQuery.trim() && (
                                        <p className="text-xs text-white/50 mb-4">Enter an artist name to continue</p>
                                    )}
                                    <div className="flex gap-3 justify-end mt-4">
                                        <button
                                            onClick={() => { setShowArtistSimilarity(false); setArtistSearchQuery(""); }}
                                            className="px-4 py-2.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                                            aria-label="Cancel"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={handleArtistSimilarityClick}
                                            disabled={artistSimilarityLoading || !artistSearchQuery.trim()}
                                            className="px-6 py-2.5 rounded-lg bg-brand text-black font-semibold hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 min-w-[140px] justify-center"
                                            aria-label="Start Radio"
                                        >
                                            {artistSimilarityLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                                            Start Radio
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </section>
                )}

                {/* Info */}
                <div className="mt-12 p-4 rounded-lg bg-white/5 border border-white/10">
                    <h3 className="text-sm font-semibold text-white mb-2">About Radio Stations</h3>
                    <p className="text-sm text-white/60">
                        Radio stations are generated from your personal music library. As you add more music, 
                        new genre and decade stations will automatically appear. Each station requires a minimum 
                        number of tracks to ensure a good listening experience.
                    </p>
                </div>
            </div>

            {/* MoodMixer Modal */}
            {showMoodMixer && (
                <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"><Loader2 className="w-12 h-12 text-white animate-spin" /></div>}>
                    <MoodMixer isOpen={showMoodMixer} onClose={() => setShowMoodMixer(false)} />
                </Suspense>
            )}

            {/* Find Similar Modal (from current track) */}
            {showSimilarSong && currentTrack?.id?.startsWith("jellyfin:") && (
                <FindSimilarModal
                    isOpen={showSimilarSong}
                    onClose={() => setShowSimilarSong(false)}
                    trackId={currentTrack.id}
                    trackTitle={currentTrack.title}
                    artistName={currentTrack.artist?.name}
                />
            )}
        </div>
    );
}

