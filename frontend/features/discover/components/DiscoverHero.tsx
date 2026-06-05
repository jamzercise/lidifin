import Link from "next/link";
import { Bookmark, Sparkles, RefreshCw } from "lucide-react";
import { format } from "date-fns";
import { PageHero } from "@/components/ui/PageHero";
import { DiscoverPlaylist, DiscoverConfig } from "../types";

interface DiscoverHeroProps {
    playlist: DiscoverPlaylist | null;
    config: DiscoverConfig | null;
}

// The backend cron regenerates enabled playlists every Sunday at 20:00.
// Compute the next occurrence in the viewer's local time as an affordance.
function nextSundayRefresh(from: Date = new Date()): Date {
    const next = new Date(from);
    const day = next.getDay(); // 0 = Sunday
    let daysUntil = (7 - day) % 7;
    if (day === 0 && next.getHours() >= 20) daysUntil = 7;
    next.setDate(next.getDate() + daysUntil);
    next.setHours(20, 0, 0, 0);
    return next;
}

export function DiscoverHero({ playlist, config }: DiscoverHeroProps) {
    // Calculate total duration
    const totalDuration =
        playlist?.tracks?.reduce((sum, t) => sum + (t.duration || 0), 0) || 0;

    const nextRefresh = nextSundayRefresh();

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    return (
        <PageHero
            accent="purple"
            eyebrow="Discover Weekly"
            icon={<Sparkles className="w-6 h-6" />}
            title="Made For You"
            subtitle={
                <span className="block space-y-1">
                    <span className="block">
                        Your personalized playlist of new music, curated from
                        your listening history.
                    </span>
                    {playlist && (
                        <span className="block text-white/50">
                            Week of{" "}
                            {format(new Date(playlist.weekStart), "MMM d, yyyy")}
                            {" • "}
                            {playlist.totalCount} songs
                            {totalDuration > 0 &&
                                `, ${formatTotalDuration(totalDuration)}`}
                            {config?.lastGeneratedAt && (
                                <>
                                    {" • "}
                                    Updated{" "}
                                    {format(
                                        new Date(config.lastGeneratedAt),
                                        "MMM d"
                                    )}
                                </>
                            )}
                        </span>
                    )}
                    {config && (
                        <span className="flex items-center gap-1.5 text-xs text-white/40">
                            <RefreshCw
                                className="w-3.5 h-3.5 shrink-0"
                                aria-hidden
                            />
                            {config.enabled
                                ? `Auto-refreshes Sundays · next ${format(
                                      nextRefresh,
                                      "MMM d"
                                  )}`
                                : "Auto-refresh off · generate manually anytime"}
                        </span>
                    )}
                </span>
            }
            actions={
                <Link
                    href="/library/saved-albums"
                    className="inline-flex items-center gap-2 text-sm font-medium text-purple-300/90 hover:text-purple-200 underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 rounded-sm"
                >
                    <Bookmark className="w-4 h-4 shrink-0" aria-hidden />
                    Saved albums for later
                </Link>
            }
        />
    );
}
