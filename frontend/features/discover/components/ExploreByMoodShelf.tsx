"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAudioControls } from "@/lib/audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { shuffleArray } from "@/utils/shuffle";
import { SectionHeader } from "@/features/home/components/SectionHeader";

interface MoodTile {
    /** Mood key understood by /library/radio, which expands it to Last.fm tag synonyms. */
    id: string;
    name: string;
    gradient: string;
}

// The same six moods the radio page offers, so a mood means the same thing
// wherever it appears.
const MOOD_TILES: MoodTile[] = [
    { id: "chill", name: "Chill", gradient: "from-teal-500/40 to-cyan-600/30" },
    { id: "energetic", name: "Energetic", gradient: "from-orange-500/40 to-red-600/30" },
    { id: "sad", name: "Melancholy", gradient: "from-indigo-500/40 to-blue-700/30" },
    { id: "romantic", name: "Romantic", gradient: "from-rose-500/40 to-pink-600/30" },
    { id: "study", name: "Focus", gradient: "from-slate-500/40 to-gray-600/30" },
    { id: "driving", name: "Driving", gradient: "from-amber-500/40 to-orange-600/30" },
];

const MIN_STATION_TRACKS = 10;

/**
 * "Explore by mood" on the Discover hub. Tapping a mood shuffles a station drawn
 * from Last.fm mood tags on the user's own library.
 *
 * This used to deep-link into the Vibe page, which needed the bundled CLAP
 * analyzer — absent from the Jellyfin image, so the shelf hid itself and the
 * feature simply never appeared. Mood tags are enriched for Jellyfin libraries
 * already, so this path needs no analyzer and no AudioMuse.
 */
export function ExploreByMoodShelf() {
    const { playTracks } = useAudioControls();
    const [loadingMood, setLoadingMood] = useState<string | null>(null);

    // Presence of any mood tag tells us enrichment has run; without it every
    // tile would dead-end in a "no tracks" toast.
    const { data: vibes, isLoading } = useQuery({
        queryKey: ["library", "vibes"],
        queryFn: () => api.get<{ vibes: { tag: string; count: number }[] }>("/library/vibes"),
        staleTime: 60 * 60 * 1000,
        select: (data) => data.vibes ?? [],
    });

    const startMoodRadio = async (mood: MoodTile) => {
        setLoadingMood(mood.id);
        try {
            const params = new URLSearchParams({
                type: "mood",
                value: mood.id,
                limit: "50",
            });
            const response = await api.get<{ tracks: Track[] }>(
                `/library/radio?${params.toString()}`
            );
            const tracks = response.tracks ?? [];

            if (tracks.length < MIN_STATION_TRACKS) {
                toast.error(`Not enough ${mood.name.toLowerCase()} tracks yet`, {
                    description:
                        tracks.length > 0
                            ? `Found ${tracks.length}, need at least ${MIN_STATION_TRACKS}.`
                            : "Try again once more of your library has been enriched.",
                });
                return;
            }

            playTracks(shuffleArray(tracks), 0);
            toast.success(`${mood.name} radio`, {
                description: `Shuffling ${tracks.length} tracks`,
            });
        } catch (error) {
            console.error("Failed to start mood radio:", error);
            toast.error("Failed to start mood radio");
        } finally {
            setLoadingMood(null);
        }
    };

    if (isLoading || !vibes || vibes.length === 0) return null;

    return (
        <section>
            <SectionHeader title="Explore by mood" showAllHref="/radio" />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {MOOD_TILES.map((tile) => {
                    const busy = loadingMood === tile.id;
                    return (
                        <button
                            key={tile.id}
                            onClick={() => startMoodRadio(tile)}
                            disabled={busy}
                            aria-label={`Play ${tile.name} radio`}
                            className={`relative overflow-hidden rounded-xl aspect-[4/3] bg-gradient-to-br ${tile.gradient} p-3 flex items-end group transition-transform hover:scale-[1.02] disabled:opacity-60 disabled:cursor-not-allowed`}
                        >
                            <span className="text-sm font-semibold text-white drop-shadow-md">
                                {tile.name}
                            </span>
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                {busy ? (
                                    <Loader2 className="w-7 h-7 text-white animate-spin" />
                                ) : (
                                    <div className="w-10 h-10 rounded-full bg-brand flex items-center justify-center shadow-lg">
                                        <Play className="w-4 h-4 fill-current text-black ml-0.5" />
                                    </div>
                                )}
                            </div>
                            <div className="absolute inset-0 ring-1 ring-inset ring-white/10 rounded-xl pointer-events-none" />
                        </button>
                    );
                })}
            </div>
        </section>
    );
}
