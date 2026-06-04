"use client";

import Link from "next/link";
import Image from "next/image";
import { Disc } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { SectionHeader } from "@/features/home/components/SectionHeader";

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    status: "upcoming" | "released" | "available";
    inLibrary: boolean;
}

interface ReleaseRadarData {
    upcoming: ReleaseItem[];
    recent: ReleaseItem[];
}

/**
 * Surfaces the Release Radar (recent + upcoming releases from monitored and
 * similar artists) as a horizontal shelf on the Discover hub. The full
 * experience — including downloads — lives on /releases, which each card and
 * the "Show all" link point to.
 */
export function NewReleasesShelf() {
    const { data, isLoading } = useQuery({
        queryKey: ["discover", "releases-radar"],
        queryFn: async (): Promise<ReleaseRadarData> => {
            return api.getReleaseRadar({ daysBack: 30, daysAhead: 90 });
        },
        staleTime: 10 * 60 * 1000,
    });

    if (isLoading) return null;

    // Lead with what's already out ("Just dropped") then what's coming up.
    const releases = [...(data?.recent ?? []), ...(data?.upcoming ?? [])].slice(
        0,
        20
    );

    if (releases.length === 0) return null;

    return (
        <section>
            <SectionHeader title="New releases for you" showAllHref="/releases" />
            <HorizontalCarousel>
                {releases.map((release) => (
                    <ReleaseShelfCard
                        key={`${release.albumMbid}-${release.id}`}
                        release={release}
                    />
                ))}
            </HorizontalCarousel>
        </section>
    );
}

function ReleaseShelfCard({ release }: { release: ReleaseItem }) {
    const isUpcoming = release.status === "upcoming";
    const badgeLabel = isUpcoming
        ? formatReleaseDate(release.releaseDate)
        : release.inLibrary
            ? "In library"
            : "Available";

    return (
        <CarouselItem>
            <Link
                href="/releases"
                className="block p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors"
            >
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                    {release.coverUrl ? (
                        <Image
                            src={release.coverUrl}
                            alt={release.title}
                            fill
                            sizes="180px"
                            className="object-cover group-hover:scale-105 transition-transform duration-300"
                            unoptimized
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center">
                            <Disc className="w-10 h-10 text-gray-600" />
                        </div>
                    )}
                    <div
                        className={cn(
                            "absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-medium",
                            isUpcoming
                                ? "bg-amber-500/90 text-black"
                                : release.inLibrary
                                    ? "bg-emerald-500/90 text-black"
                                    : "bg-white/20 text-white"
                        )}
                    >
                        {badgeLabel}
                    </div>
                </div>
                <h3 className="text-sm font-semibold text-white truncate">
                    {release.title}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {release.artistName}
                </p>
            </Link>
        </CarouselItem>
    );
}

function formatReleaseDate(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.ceil(
        (date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Tomorrow";
    if (diffDays > 0 && diffDays <= 7) return `In ${diffDays}d`;
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
