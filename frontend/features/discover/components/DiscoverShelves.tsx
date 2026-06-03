"use client";

import { useState } from "react";
import { Compass } from "lucide-react";
import { cn } from "@/utils/cn";
import {
    useBecauseYouListenedQuery,
    useBrowseAllQuery,
    useRecommendationsQuery,
} from "@/hooks/useQueries";
import { BecauseYouListenedTo } from "@/features/home/components/BecauseYouListenedTo";
import { FeaturedPlaylistsGrid } from "@/features/home/components/FeaturedPlaylistsGrid";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { NewReleasesShelf } from "./NewReleasesShelf";
import { ExploreByMoodShelf } from "./ExploreByMoodShelf";
import { HiddenGemsShelf } from "./HiddenGemsShelf";
import type { UnavailableAlbum } from "../types";

type ShelfFilter = "all" | "releases" | "mood" | "gems" | "artists" | "playlists";

interface DiscoverShelvesProps {
    /** Recommended albums not in the library (with previews), for "Hidden gems". */
    hiddenGems?: UnavailableAlbum[];
    currentPreview?: string | null;
    onTogglePreview?: (albumId: string, previewUrl: string) => void;
}

/**
 * The "More ways to discover" region of the Discover hub. Discover Weekly is the
 * headline experience above; this surfaces complementary discovery rails
 * (release radar, mood explorer, taste-based + recommended artists, featured
 * playlists) in a single scroll so they stop hiding on separate pages.
 *
 * Built as a thin composition over existing, cached query hooks and home rails
 * so it stays cheap to render and easy to extend with future sources (e.g.
 * hidden gems / song radio in E3, YouTube Music recommendations later).
 */
export function DiscoverShelves({
    hiddenGems = [],
    currentPreview = null,
    onTogglePreview,
}: DiscoverShelvesProps) {
    const [filter, setFilter] = useState<ShelfFilter>("all");

    const { data: becauseData } = useBecauseYouListenedQuery(3);
    const { data: recommendedData } = useRecommendationsQuery(12);
    const { data: browseData } = useBrowseAllQuery();

    const becauseSections = becauseData?.sections ?? [];
    const recommendedArtists = recommendedData?.artists ?? [];
    const featuredPlaylists = browseData?.playlists ?? [];

    const filters: Array<{ id: ShelfFilter; label: string }> = [
        { id: "all", label: "All" },
        { id: "releases", label: "New releases" },
        { id: "mood", label: "Mood" },
        ...(hiddenGems.length > 0
            ? [{ id: "gems" as const, label: "Hidden gems" }]
            : []),
        { id: "artists", label: "Artists" },
        { id: "playlists", label: "Playlists" },
    ];

    const show = (id: ShelfFilter) => filter === "all" || filter === id;

    return (
        <div className="space-y-10">
            <div>
                <div className="flex items-center gap-3 mb-4">
                    <Compass className="w-5 h-5 text-purple-400" />
                    <h2 className="text-xl font-bold text-white">
                        More ways to discover
                    </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                    {filters.map((f) => (
                        <button
                            key={f.id}
                            onClick={() => setFilter(f.id)}
                            aria-pressed={filter === f.id}
                            className={cn(
                                "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                                filter === f.id
                                    ? "bg-white text-black"
                                    : "bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
                            )}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {show("releases") && <NewReleasesShelf />}

            {show("mood") && <ExploreByMoodShelf />}

            {show("gems") && onTogglePreview && (
                <HiddenGemsShelf
                    gems={hiddenGems}
                    currentPreview={currentPreview}
                    onTogglePreview={onTogglePreview}
                />
            )}

            {show("artists") && becauseSections.length > 0 && (
                <BecauseYouListenedTo sections={becauseSections} />
            )}

            {show("artists") && recommendedArtists.length > 0 && (
                <section>
                    <SectionHeader title="Artists for you" />
                    <ArtistsGrid artists={recommendedArtists} />
                </section>
            )}

            {show("playlists") && featuredPlaylists.length > 0 && (
                <section>
                    <SectionHeader
                        title="Fresh playlists"
                        showAllHref="/browse/playlists"
                    />
                    <FeaturedPlaylistsGrid playlists={featuredPlaylists} />
                </section>
            )}
        </div>
    );
}
