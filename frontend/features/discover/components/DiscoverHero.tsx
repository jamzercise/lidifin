import Link from "next/link";
import { Bookmark, Sparkles, RefreshCw, Music, Clock, Calendar } from "lucide-react";
import { format } from "date-fns";
import { PageHero, PageHeroStat } from "@/components/ui/PageHero";
import { api } from "@/lib/api";
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
            return `${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    // Blur a few (distinct) album covers from this week's picks into the hero
    const heroBackdrop: string[] = [];
    {
        const seenAlbums = new Set<string>();
        for (const t of playlist?.tracks ?? []) {
            if (t.coverUrl && !seenAlbums.has(t.albumId)) {
                seenAlbums.add(t.albumId);
                heroBackdrop.push(api.getCoverArtUrl(t.coverUrl, 200));
                if (heroBackdrop.length >= 4) break;
            }
        }
    }

    const stats: PageHeroStat[] = [];
    if (playlist) {
        stats.push({
            icon: <Music />,
            label: `${playlist.totalCount} songs`,
        });
        if (totalDuration > 0) {
            stats.push({
                icon: <Clock />,
                label: formatTotalDuration(totalDuration),
            });
        }
        stats.push({
            icon: <Calendar />,
            label: `Week of ${format(new Date(playlist.weekStart), "MMM d")}`,
        });
    }
    if (config) {
        stats.push({
            icon: <RefreshCw />,
            label: config.enabled
                ? `Refreshes ${format(nextRefresh, "EEE, MMM d")}`
                : "Auto-refresh off",
        });
    }

    return (
        <PageHero
            accent="purple"
            eyebrow="Discover Weekly"
            icon={<Sparkles className="w-6 h-6" />}
            title="Made For You"
            subtitle="Your personalized playlist of new music, curated from your listening history."
            backdropImages={heroBackdrop}
            stats={stats.length > 0 ? stats : undefined}
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
