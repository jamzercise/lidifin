"use client";

import { Music2, Play, Pause } from "lucide-react";
import { cn } from "@/utils/cn";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import type { UnavailableAlbum } from "../types";

const tierLabels: Record<string, string> = {
    high: "High match",
    medium: "Medium match",
    explore: "Explore",
    wildcard: "Wild card",
};

const tierColors: Record<string, string> = {
    high: "text-green-400",
    medium: "text-yellow-400",
    explore: "text-orange-400",
    wildcard: "text-purple-400",
};

interface HiddenGemsShelfProps {
    gems: UnavailableAlbum[];
    currentPreview: string | null;
    onTogglePreview: (albumId: string, previewUrl: string) => void;
}

/**
 * "Hidden gems" — albums Discovery recommended for you that aren't in your
 * library (your indexers couldn't find them). Surfaced as a browsable shelf
 * with 30-second previews so they're explorable rather than buried in a
 * collapsed "N unavailable" accordion.
 */
export function HiddenGemsShelf({
    gems,
    currentPreview,
    onTogglePreview,
}: HiddenGemsShelfProps) {
    if (!gems || gems.length === 0) return null;

    return (
        <section>
            <SectionHeader title="Hidden gems" />
            <p className="text-sm text-gray-400 -mt-2 mb-4">
                Recommended for you but not in your library yet — preview them
                here.
            </p>
            <HorizontalCarousel>
                {gems.slice(0, 20).map((gem) => {
                    const isPreviewing = currentPreview === gem.id;
                    return (
                        <CarouselItem key={gem.id}>
                            <div className="p-3 rounded-md group">
                                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-gradient-to-br from-purple-600/20 to-amber-600/10 flex items-center justify-center shadow-lg">
                                    <Music2 className="w-10 h-10 text-white/20" />
                                    {gem.tier && (
                                        <span
                                            className={cn(
                                                "absolute top-2 left-2 px-1.5 py-0.5 rounded text-[10px] font-medium bg-black/40",
                                                tierColors[gem.tier]
                                            )}
                                        >
                                            {tierLabels[gem.tier] ?? gem.tier}
                                        </span>
                                    )}
                                    {gem.previewUrl && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onTogglePreview(
                                                    gem.id,
                                                    gem.previewUrl!
                                                )
                                            }
                                            aria-label={
                                                isPreviewing
                                                    ? `Pause preview of ${gem.album}`
                                                    : `Play 30-second preview of ${gem.album}`
                                            }
                                            className={cn(
                                                "absolute bottom-2 right-2 w-10 h-10 rounded-full bg-[#B1D2C3] flex items-center justify-center shadow-xl hover:scale-105 transition-all",
                                                !isPreviewing &&
                                                    "opacity-0 group-hover:opacity-100"
                                            )}
                                        >
                                            {isPreviewing ? (
                                                <Pause className="w-4 h-4 text-black fill-current" />
                                            ) : (
                                                <Play className="w-4 h-4 text-black fill-current ml-0.5" />
                                            )}
                                        </button>
                                    )}
                                </div>
                                <h3 className="text-sm font-semibold text-white truncate">
                                    {gem.album}
                                </h3>
                                <p className="text-xs text-gray-400 mt-0.5 truncate">
                                    {gem.artist}
                                    {gem.previewUrl && (
                                        <span className="text-[#B1D2C3]">
                                            {" "}
                                            · 30s preview
                                        </span>
                                    )}
                                </p>
                            </div>
                        </CarouselItem>
                    );
                })}
            </HorizontalCarousel>
        </section>
    );
}
