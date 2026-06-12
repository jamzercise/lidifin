"use client";

import { useState, useEffect } from "react";
import { Calendar, Clock, Download, Music2, Disc, ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { PageHero } from "@/components/ui/PageHero";
import { CoverCard } from "@/components/ui/CoverCard";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { useToast } from "@/lib/toast-context";
import { api } from "@/lib/api";
import Link from "next/link";

interface ReleaseItem {
    id: number | string;
    title: string;
    artistName: string;
    artistMbid?: string;
    albumMbid: string;
    releaseDate: string;
    coverUrl: string | null;
    source: 'lidarr' | 'similar';
    status: 'upcoming' | 'released' | 'available';
    inLibrary: boolean;
    canDownload: boolean;
}

interface ReleaseRadarData {
    upcoming: ReleaseItem[];
    recent: ReleaseItem[];
    monitoredArtistCount: number;
    similarArtistCount: number;
}

export default function ReleasesPage() {
    const [data, setData] = useState<ReleaseRadarData | null>(null);
    const [loading, setLoading] = useState(true);
    const [downloadingId, setDownloadingId] = useState<string | number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { toast } = useToast();

    const fetchReleases = async () => {
        try {
            setLoading(true);
            const json = await api.getReleaseRadar({ daysBack: 30, daysAhead: 90 });
            setData(json);
            setError(null);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to fetch releases");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchReleases();
    }, []);

    const handleDownload = async (release: ReleaseItem) => {
        try {
            setDownloadingId(release.id);
            const json = await api.downloadRelease(release.albumMbid, {
                artistName: release.artistName,
                albumTitle: release.title,
                artistMbid: release.artistMbid,
            });
            toast.success(
                json.message || `Queued "${release.title}" for download`
            );
            // Refresh to show updated status
            await fetchReleases();
        } catch (err) {
            console.error("Download failed:", err);
            const message =
                err instanceof Error ? err.message : "Failed to start download";
            toast.error(message);
        } finally {
            setDownloadingId(null);
        }
    };

    const formatDate = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diffDays = Math.ceil((date.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        
        if (diffDays === 0) return "Today";
        if (diffDays === 1) return "Tomorrow";
        if (diffDays > 0 && diffDays <= 7) return `In ${diffDays} days`;
        if (diffDays < 0 && diffDays >= -7) return `${Math.abs(diffDays)} days ago`;
        
        return date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
        });
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen text-white/60">
                <Music2 className="w-12 h-12 mb-4 opacity-40" />
                <p>Failed to load releases</p>
                <p className="text-sm">{error}</p>
            </div>
        );
    }

    const heroBackdrop = [
        ...(data?.recent ?? []),
        ...(data?.upcoming ?? []),
    ]
        .map((r) => r.coverUrl)
        .filter(Boolean)
        .slice(0, 4);

    return (
        <div className="min-h-screen pb-32">
            <PageHero
                accent="amber"
                eyebrow="Release Radar"
                icon={<Calendar className="w-6 h-6" />}
                title="New & Upcoming"
                subtitle="New and upcoming releases from artists you follow and similar artists."
                backdropImages={heroBackdrop}
                stats={[
                    {
                        icon: <Music2 />,
                        label: `${data?.monitoredArtistCount || 0} monitored artists`,
                    },
                    {
                        icon: <Clock />,
                        label: `${data?.upcoming.length || 0} upcoming`,
                    },
                    {
                        icon: <Disc />,
                        label: `${data?.recent.length || 0} recent`,
                    },
                ]}
            />

            <div className="px-4 md:px-8 space-y-10">
                {/* Upcoming Releases */}
                {data?.upcoming && data.upcoming.length > 0 && (
                    <section>
                        <SectionHeading
                            accent="amber"
                            icon={<Clock className="w-5 h-5" />}
                            title="Coming Soon"
                            count={data.upcoming.length}
                        />

                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                            {data.upcoming.map((release) => (
                                <ReleaseCard
                                    key={`${release.albumMbid}-${release.id}`}
                                    release={release}
                                    formatDate={formatDate}
                                    onDownload={handleDownload}
                                    isDownloading={downloadingId === release.id}
                                />
                            ))}
                        </div>
                    </section>
                )}

                {/* Recently Released */}
                {data?.recent && data.recent.length > 0 && (
                    <section>
                        <SectionHeading
                            accent="emerald"
                            icon={<Disc className="w-5 h-5" />}
                            title="Just Dropped"
                            count={data.recent.length}
                        />

                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                            {data.recent.map((release) => (
                                <ReleaseCard
                                    key={`${release.albumMbid}-${release.id}`}
                                    release={release}
                                    formatDate={formatDate}
                                    onDownload={handleDownload}
                                    isDownloading={downloadingId === release.id}
                                />
                            ))}
                        </div>
                    </section>
                )}

                {/* Empty State */}
                {(!data?.upcoming?.length && !data?.recent?.length) && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <Calendar className="w-16 h-16 text-white/20 mb-6" />
                        <h3 className="text-xl font-medium text-white mb-2">No releases found</h3>
                        <p className="text-white/50 max-w-md mb-6">
                            Add artists to Lidarr and enable monitoring to see their upcoming and recent releases here.
                        </p>
                        <Link
                            href="/settings"
                            className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500/20 text-amber-400 rounded-lg hover:bg-amber-500/30 transition-colors"
                        >
                            Configure Lidarr
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}

function ReleaseCard({
    release,
    formatDate,
    onDownload,
    isDownloading,
}: {
    release: ReleaseItem;
    formatDate: (date: string) => string;
    onDownload: (release: ReleaseItem) => void;
    isDownloading: boolean;
}) {
    const isUpcoming = release.status === 'upcoming';
    const hasIt = release.inLibrary;

    const badge = isUpcoming
        ? { label: formatDate(release.releaseDate), tone: "accent" as const }
        : hasIt
            ? { label: "In Library", tone: "success" as const }
            : { label: "Available", tone: "neutral" as const };

    return (
        <CoverCard
            accent="amber"
            title={release.title}
            subtitle={release.artistName}
            imageUrl={release.coverUrl}
            placeholderIcon={<Disc className="w-12 h-12" />}
            badge={badge}
            cornerIndicator={
                hasIt ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                ) : undefined
            }
            action={
                release.canDownload && !hasIt
                    ? {
                          icon: isDownloading ? (
                              <Loader2 className="w-8 h-8 animate-spin" />
                          ) : (
                              <Download className="w-8 h-8" />
                          ),
                          label: `Download ${release.title} by ${release.artistName}`,
                          onClick: () => onDownload(release),
                          loading: isDownloading,
                      }
                    : undefined
            }
            caption={
                isUpcoming ? (
                    <span className="text-amber-400/80">
                        {new Date(release.releaseDate).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                        })}
                    </span>
                ) : undefined
            }
        />
    );
}
