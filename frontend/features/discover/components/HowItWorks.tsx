"use client";

import { Sparkles, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";

export function HowItWorks({ exclusionMonths }: { exclusionMonths?: number }) {
    const months = exclusionMonths ?? 6;
    const exclusionText =
        months === 0
            ? "Albums can be recommended again any week (exclusion disabled)"
            : `Albums won't repeat for ${months} month${months === 1 ? "" : "s"}`;
    return (
        <Card className="p-6 bg-[#111]/50  border-white/5">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-white">
                <Sparkles className="w-5 h-5 text-purple-400" />
                How It Works
            </h3>
            <div className="space-y-3 text-sm text-gray-400">
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        Analyzes your listening history and library using
                        Last.fm similarity data
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        Discovers similar artists across tiers: High (80-100%),
                        Medium (50-79%), Explore (30-49%), Wild Cards (0-29%)
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        One song per album downloads the full album to
                        /music/discovery
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        Tap the <span className="text-purple-300">heart</span> to
                        keep an album in your library — kept albums stay, the rest
                        are removed at week end.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        Found an unavailable album you want later? Use{" "}
                        <span className="text-purple-300">Save for later</span> on
                        its album page to bookmark it on your{" "}
                        <span className="text-purple-300">Saved albums</span> list
                        until it becomes available.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>{exclusionText}</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-purple-400/60 shrink-0" />
                    <p>
                        If albums aren&apos;t available, they&apos;re automatically
                        replaced and you can still preview them via Deezer
                    </p>
                </div>
            </div>
        </Card>
    );
}
