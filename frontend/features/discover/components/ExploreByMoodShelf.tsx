"use client";

import Link from "next/link";
import { useFeatures } from "@/lib/features-context";
import { SectionHeader } from "@/features/home/components/SectionHeader";

interface MoodTile {
    id: string;
    name: string;
    /** Vibe search query passed to /vibe?q=… */
    query: string;
    /** Tailwind gradient classes for the tile background. */
    gradient: string;
}

// Mirrors the presets on the Vibe page so the language stays consistent across
// the hub and the explorer it deep-links into.
const MOOD_TILES: MoodTile[] = [
    {
        id: "chill",
        name: "Chill",
        query: "relaxing calm ambient peaceful mellow",
        gradient: "from-teal-500/40 to-sky-600/30",
    },
    {
        id: "energy",
        name: "High Energy",
        query: "energetic powerful intense driving upbeat",
        gradient: "from-rose-500/40 to-orange-500/30",
    },
    {
        id: "dark",
        name: "Dark",
        query: "dark atmospheric moody brooding cinematic",
        gradient: "from-slate-600/50 to-purple-700/30",
    },
    {
        id: "happy",
        name: "Feel Good",
        query: "happy upbeat cheerful bright positive",
        gradient: "from-amber-400/40 to-pink-500/30",
    },
    {
        id: "melancholic",
        name: "Melancholic",
        query: "sad melancholic emotional nostalgic bittersweet",
        gradient: "from-indigo-500/40 to-blue-700/30",
    },
    {
        id: "electronic",
        name: "Electronic",
        query: "electronic synth digital pulsing techno",
        gradient: "from-fuchsia-500/40 to-cyan-500/30",
    },
];

/**
 * Surfaces the Vibe explorer's mood presets as an "Explore by mood" shelf on the
 * Discover hub. Each tile deep-links into /vibe with the preset query so a tap
 * lands the user on a ready-made vibe result set.
 *
 * Only rendered when the CLAP analyzer (vibe embeddings) is available — without
 * it the Vibe page can't return results, so we hide the shelf rather than lead
 * users to a dead end.
 */
export function ExploreByMoodShelf() {
    const { vibeEmbeddings, loading } = useFeatures();

    if (loading || !vibeEmbeddings) return null;

    return (
        <section>
            <SectionHeader title="Explore by mood" showAllHref="/vibe" />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                {MOOD_TILES.map((tile) => (
                    <Link
                        key={tile.id}
                        href={`/vibe?q=${encodeURIComponent(tile.query)}`}
                        className={`relative overflow-hidden rounded-xl aspect-[4/3] bg-gradient-to-br ${tile.gradient} p-3 flex items-end group transition-transform hover:scale-[1.02]`}
                    >
                        <span className="text-sm font-semibold text-white drop-shadow-md">
                            {tile.name}
                        </span>
                        <div className="absolute inset-0 ring-1 ring-inset ring-white/10 rounded-xl pointer-events-none" />
                    </Link>
                ))}
            </div>
        </section>
    );
}
