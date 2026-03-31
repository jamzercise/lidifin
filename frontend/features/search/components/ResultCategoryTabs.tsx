"use client";

import { cn } from "@/utils/cn";
import type { ResultCategory } from "../types";

interface ResultCategoryTabsProps {
    category: ResultCategory;
    onChange: (cat: ResultCategory) => void;
    counts: {
        artists: number;
        albums: number;
        songs: number;
        playlists: number;
    };
}

const TABS: { key: ResultCategory; label: string }[] = [
    { key: "all", label: "All" },
    { key: "artists", label: "Artists" },
    { key: "albums", label: "Albums" },
    { key: "songs", label: "Songs" },
    { key: "playlists", label: "Playlists" },
];

export function ResultCategoryTabs({ category, onChange, counts }: ResultCategoryTabsProps) {
    return (
        <div className="flex gap-2 flex-wrap" data-tv-section="result-category-tabs">
            {TABS.map((tab, idx) => {
                const count =
                    tab.key === "all"
                        ? counts.artists + counts.albums + counts.songs + counts.playlists
                        : counts[tab.key];

                if (tab.key !== "all" && count === 0) return null;

                return (
                    <button
                        key={tab.key}
                        data-tv-card
                        data-tv-card-index={idx}
                        tabIndex={0}
                        onClick={() => onChange(tab.key)}
                        className={cn(
                            "px-3 py-1.5 text-xs font-semibold rounded-full transition-all",
                            category === tab.key
                                ? "bg-white/20 text-white"
                                : "bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white",
                        )}
                    >
                        {tab.label}
                        {tab.key !== "all" && count > 0 && (
                            <span className="ml-1.5 text-[10px] opacity-60">{count}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
