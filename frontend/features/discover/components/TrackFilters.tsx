"use client";

import { cn } from "@/utils/cn";
import type { DiscoverTrack } from "../types";

export type TrackSort = "order" | "match" | "tier";

const TIERS: Array<{ value: string; label: string; color: string }> = [
    { value: "all", label: "All", color: "text-white" },
    { value: "high", label: "High", color: "text-green-400" },
    { value: "medium", label: "Medium", color: "text-yellow-400" },
    { value: "explore", label: "Explore", color: "text-orange-400" },
    { value: "wildcard", label: "Wild Card", color: "text-purple-400" },
];

interface TrackFiltersProps {
    tracks: DiscoverTrack[];
    sortBy: TrackSort;
    onSortChange: (sort: TrackSort) => void;
    tierFilter: string;
    onTierChange: (tier: string) => void;
}

export function TrackFilters({
    tracks,
    sortBy,
    onSortChange,
    tierFilter,
    onTierChange,
}: TrackFiltersProps) {
    const counts = tracks.reduce<Record<string, number>>((acc, t) => {
        acc[t.tier] = (acc[t.tier] || 0) + 1;
        return acc;
    }, {});

    return (
        <div className="flex flex-wrap items-center justify-between gap-3 pb-1">
            <div className="flex flex-wrap items-center gap-1.5">
                {TIERS.map((tier) => {
                    const count =
                        tier.value === "all"
                            ? tracks.length
                            : counts[tier.value] || 0;
                    if (tier.value !== "all" && count === 0) return null;
                    const active = tierFilter === tier.value;
                    return (
                        <button
                            key={tier.value}
                            onClick={() => onTierChange(tier.value)}
                            aria-pressed={active}
                            className={cn(
                                "px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
                                active
                                    ? "bg-white/10 border-white/20 text-white"
                                    : "bg-transparent border-white/5 hover:bg-white/5",
                                !active && tier.color
                            )}
                        >
                            {tier.label}
                            <span className="ml-1 text-[10px] text-gray-500">
                                {count}
                            </span>
                        </button>
                    );
                })}
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-400">
                Sort
                <select
                    value={sortBy}
                    onChange={(e) => onSortChange(e.target.value as TrackSort)}
                    className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-purple-500/40"
                >
                    <option value="order">Playlist order</option>
                    <option value="match">Best match</option>
                    <option value="tier">By tier</option>
                </select>
            </label>
        </div>
    );
}
