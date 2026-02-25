"use client";

import { Skeleton, TrackListSkeleton } from "@/components/ui/Skeleton";

export function AlbumPageSkeleton() {
    return (
        <div className="min-h-screen flex flex-col bg-black">
            {/* Hero skeleton */}
            <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-b from-[#2a1a1a] to-[#0a0a0a]" />
                <div className="relative px-4 md:px-8 pt-16 pb-6">
                    <div className="flex items-end gap-6">
                        <Skeleton className="w-40 h-40 md:w-52 md:h-52 flex-shrink-0 rounded-sm" />
                        <div className="flex-1 pb-2 space-y-4 min-w-0">
                            <Skeleton className="h-5 w-20" />
                            <Skeleton className="h-10 w-56 max-w-full" />
                            <Skeleton className="h-4 w-32" />
                            <div className="flex gap-4">
                                <Skeleton className="h-10 w-24 rounded-full" />
                                <Skeleton className="h-10 w-24 rounded-full" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Content skeleton */}
            <div className="relative flex-1 px-4 md:px-8 py-6">
                <TrackListSkeleton count={12} />
            </div>
        </div>
    );
}
