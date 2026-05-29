import Link from "next/link";
import { Bookmark, Music2, RefreshCw } from "lucide-react";
import { format } from "date-fns";
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
        <div className="relative bg-gradient-to-b from-purple-900/40 via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
            <div className="flex items-end gap-6">
                {/* Icon */}
                <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-gradient-to-br from-purple-600/30 to-yellow-600/20 rounded shadow-2xl shrink-0 flex items-center justify-center border border-white/10">
                    <Music2 className="w-16 h-16 md:w-20 md:h-20 text-purple-400" />
                </div>

                {/* Info - Bottom Aligned */}
                <div className="flex-1 min-w-0 pb-1">
                    <p className="text-xs font-medium text-white/90 mb-1">
                        Playlist
                    </p>
                    <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                        Discover Weekly
                    </h1>
                    <p className="text-sm text-white/60 mb-2 line-clamp-2">
                        Your personalized playlist of new music, curated based
                        on your listening history.
                    </p>
                    <div className="flex flex-wrap items-center gap-1 text-sm text-white/70">
                        {playlist && (
                            <>
                                <span>
                                    Week of{" "}
                                    {format(
                                        new Date(playlist.weekStart),
                                        "MMM d, yyyy"
                                    )}
                                </span>
                                <span className="mx-1">•</span>
                                <span>{playlist.totalCount} songs</span>
                                {totalDuration > 0 && (
                                    <span>
                                        , {formatTotalDuration(totalDuration)}
                                    </span>
                                )}
                            </>
                        )}
                        {config?.lastGeneratedAt && (
                            <>
                                <span className="mx-1">•</span>
                                <span>
                                    Updated{" "}
                                    {format(
                                        new Date(config.lastGeneratedAt),
                                        "MMM d"
                                    )}
                                </span>
                            </>
                        )}
                    </div>
                    {config && (
                        <p className="flex items-center gap-1.5 text-xs text-white/50 mt-2">
                            <RefreshCw className="w-3.5 h-3.5 shrink-0" aria-hidden />
                            {config.enabled ? (
                                <span>
                                    Auto-refreshes Sundays · next{" "}
                                    {format(nextRefresh, "MMM d")}
                                </span>
                            ) : (
                                <span>
                                    Auto-refresh off · generate manually anytime
                                </span>
                            )}
                        </p>
                    )}
                    <div className="mt-3">
                        <Link
                            href="/library/saved-albums"
                            className="inline-flex items-center gap-2 text-sm font-medium text-purple-300/90 hover:text-purple-200 underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 rounded-sm"
                        >
                            <Bookmark className="w-4 h-4 shrink-0" aria-hidden />
                            Saved albums for later
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    );
}
