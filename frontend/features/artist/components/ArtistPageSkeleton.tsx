"use client";

import { Skeleton, TrackListSkeleton } from "@/components/ui/Skeleton";

export function ArtistPageSkeleton() {
    return (
        <div className="min-h-screen flex flex-col bg-black">
            {/* Hero skeleton */}
            <div className="relative">
                <div className="absolute inset-0 bg-gradient-to-b from-[#2a1a1a] to-[#0a0a0a]" />
                <div className="relative px-4 md:px-8 pt-16 pb-6">
                    <div className="flex items-end gap-6">
                        <Skeleton className="w-40 h-40 md:w-48 md:h-48 rounded-full flex-shrink-0" />
                        <div className="flex-1 pb-2 space-y-4 min-w-0">
                            <Skeleton className="h-10 w-48 max-w-full" />
                            <div className="flex gap-4">
                                <Skeleton className="h-10 w-24 rounded-full" />
                                <Skeleton className="h-10 w-24 rounded-full" />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Content skeleton */}
            <div className="relative flex-1 px-4 md:px-8 py-6 space-y-8">
                {/* Bio placeholder */}
                <section>
                    <Skeleton className="h-5 w-24 mb-3" />
                    <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-3/4" />
                    </div>
                </section>

                {/* Popular tracks */}
                <section>
                    <Skeleton className="h-6 w-20 mb-4" />
                    <TrackListSkeleton count={5} />
                </section>

                {/* Discography */}
                <section>
                    <Skeleton className="h-6 w-28 mb-4" />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <div key={i} className="space-y-2">
                                <Skeleton className="aspect-square w-full rounded" />
                                <Skeleton className="h-4 w-full" />
                                <Skeleton className="h-3 w-16" />
                            </div>
                        ))}
                    </div>
                </section>
            </div>
        </div>
    );
}
