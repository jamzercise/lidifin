"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import {
    isImportFinished,
    importStatusLabel,
    useActiveImports,
    useImportJobTracks,
    type ImportTrackState,
} from "@/hooks/useActiveImports";
import { ImportTrackListRow } from "@/features/import/components/ImportTrackRow";

/** Track states grouped for filtering, most actionable first. */
const FILTERS: Array<{
    id: string;
    label: string;
    states: ImportTrackState[] | null;
}> = [
    { id: "all", label: "All", states: null },
    {
        id: "waiting",
        label: "Waiting",
        states: ["downloading", "queued"],
    },
    {
        id: "problems",
        label: "Needs attention",
        states: ["download_failed", "no_source", "unmatched"],
    },
    { id: "done", label: "Ready", states: ["in_library", "downloaded"] },
];

export default function ImportJobPage() {
    const params = useParams();
    const router = useRouter();
    const { toast } = useToast();

    const jobId = typeof params.jobId === "string" ? params.jobId : null;

    const { detail, isLoading, error, refetch } = useImportJobTracks(jobId);
    const { forget: forgetActiveImport, refetch: refetchActiveImports } =
        useActiveImports();

    const [filter, setFilter] = useState("all");
    const [skippingId, setSkippingId] = useState<string | null>(null);
    const [isCancelling, setIsCancelling] = useState(false);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isFinishing, setIsFinishing] = useState(false);

    const visibleTracks = useMemo(() => {
        if (!detail) return [];
        const active = FILTERS.find((f) => f.id === filter);
        if (!active?.states) return detail.tracks;
        return detail.tracks.filter((t) => active.states!.includes(t.state));
    }, [detail, filter]);

    const finished = detail ? isImportFinished(detail.status) : false;
    const waitingCount = detail?.skippableDownloadIds.length ?? 0;
    // Offered whenever the playlist hasn't been built, not just while downloads
    // are outstanding: an import also parks after a download has failed
    // outright, and that is precisely when it needs a way out.
    const canFinishNow = Boolean(detail && !finished && !detail.createdPlaylistId);

    const skipDownloads = async (
        downloadJobIds: string[] | null,
        busyKey: string
    ) => {
        if (!jobId) return;
        setSkippingId(busyKey);
        try {
            const result = await api.post<{ skipped: number; message: string }>(
                `/spotify/import/${jobId}/skip-downloads`,
                downloadJobIds ? { downloadJobIds } : {}
            );
            toast.success(result.message);
            await refetch();
            refetchActiveImports();
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : "Failed to skip downloads"
            );
        } finally {
            setSkippingId(null);
        }
    };

    const handleFinishNow = async () => {
        if (!jobId) return;
        setIsFinishing(true);
        try {
            const result = await api.post<{
                message: string;
                playlistId: string | null;
            }>(`/spotify/import/${jobId}/finish`, {});
            toast.success(result.message);
            await refetch();
            refetchActiveImports();
        } catch (err) {
            toast.error(
                err instanceof Error
                    ? err.message
                    : "Failed to finish this import"
            );
        } finally {
            setIsFinishing(false);
        }
    };

    const handleCancel = async () => {
        if (!jobId) return;
        setIsCancelling(true);
        try {
            const result = await api.post<{ message: string }>(
                `/spotify/import/${jobId}/cancel`,
                {}
            );
            toast.success(result.message || "Import cancelled");
            forgetActiveImport(jobId);
            await refetch();
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : "Failed to cancel import"
            );
        } finally {
            setIsCancelling(false);
        }
    };

    const handleRecheck = async () => {
        if (!jobId) return;
        setIsRefreshing(true);
        try {
            const result = await api.post<{
                added: number;
                total: number;
                message: string;
            }>(`/spotify/import/${jobId}/refresh`, {});
            toast.success(result.message);
            await refetch();
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : "Failed to re-check"
            );
        } finally {
            setIsRefreshing(false);
        }
    };

    if (!jobId) return null;

    return (
        <div className="min-h-screen relative">
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-linear-to-b from-[#B1D2C3]/15 via-purple-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
            </div>

            <div className="relative max-w-3xl mx-auto px-6 py-6">
                <div className="flex items-center gap-4 mb-6">
                    <button
                        onClick={() => router.back()}
                        className="p-2 hover:bg-white/5 rounded-full transition-colors"
                        aria-label="Go back"
                    >
                        <ArrowLeft className="w-5 h-5 text-gray-400" />
                    </button>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-bold text-white truncate">
                            {detail?.playlistName || "Playlist import"}
                        </h1>
                        <p className="text-sm text-gray-400">
                            {detail
                                ? `${importStatusLabel(detail.status)} • ${
                                      detail.progress
                                  }%`
                                : "Loading import…"}
                        </p>
                    </div>
                </div>

                {isLoading && !detail && (
                    <div className="flex items-center gap-3 text-gray-400 py-12 justify-center">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Loading import…
                    </div>
                )}

                {error && !detail && (
                    <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20">
                        <p className="text-sm text-red-300">{error}</p>
                        <Link
                            href="/import/spotify"
                            className="text-sm text-[#B1D2C3] hover:underline mt-2 inline-block"
                        >
                            Start a new import
                        </Link>
                    </div>
                )}

                {detail && (
                    <>
                        {/* Overall progress */}
                        {!finished && (
                            <div className="mb-5">
                                <div className="w-full bg-white/10 rounded-full h-1.5">
                                    <div
                                        className="bg-[#1DB954] h-1.5 rounded-full transition-all duration-500"
                                        style={{
                                            width: `${detail.progress}%`,
                                        }}
                                    />
                                </div>
                            </div>
                        )}

                        {detail.error && (
                            <div className="mb-5 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                                <p className="text-sm text-red-300">
                                    {detail.error}
                                </p>
                            </div>
                        )}

                        {/* Counts */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                            <SummaryCard
                                label="Ready"
                                value={
                                    detail.summary.inLibrary +
                                    detail.summary.downloaded
                                }
                                tone="text-[#1DB954]"
                            />
                            <SummaryCard
                                label="Waiting"
                                value={detail.summary.inFlight}
                                tone="text-[#B1D2C3]"
                            />
                            <SummaryCard
                                label="Failed"
                                value={detail.summary.failed}
                                tone="text-red-400"
                            />
                            <SummaryCard
                                label="Unresolved"
                                value={detail.summary.unresolved}
                                tone="text-amber-400"
                            />
                        </div>

                        {/* Actions */}
                        <div className="flex flex-wrap items-center gap-2 mb-5">
                            {canFinishNow && (
                                <button
                                    onClick={handleFinishNow}
                                    disabled={isFinishing || skippingId !== null}
                                    className="px-4 py-2 rounded-full text-sm font-medium bg-[#B1D2C3] text-black hover:brightness-110 transition-all disabled:opacity-50"
                                    title="Create the playlist from the songs that are ready, leaving the rest behind"
                                >
                                    {isFinishing ? (
                                        <>
                                            <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-2" />
                                            Creating playlist…
                                        </>
                                    ) : waitingCount > 0 ? (
                                        `Finish now (skip ${waitingCount} download${
                                            waitingCount === 1 ? "" : "s"
                                        })`
                                    ) : (
                                        "Create playlist now"
                                    )}
                                </button>
                            )}

                            <button
                                onClick={handleRecheck}
                                disabled={isRefreshing}
                                className="px-4 py-2 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-50"
                                title="Look for songs that have arrived since the playlist was built"
                            >
                                {isRefreshing ? (
                                    <>
                                        <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-2" />
                                        Checking…
                                    </>
                                ) : (
                                    <>
                                        <RefreshCw className="w-3.5 h-3.5 inline mr-2" />
                                        Re-check library
                                    </>
                                )}
                            </button>

                            {detail.createdPlaylistId && (
                                <Link
                                    href={`/playlist/${detail.createdPlaylistId}`}
                                    className="px-4 py-2 rounded-full text-sm font-medium text-gray-300 hover:text-white hover:bg-white/10 border border-white/10 transition-colors"
                                >
                                    <ExternalLink className="w-3.5 h-3.5 inline mr-2" />
                                    Open playlist
                                </Link>
                            )}

                            {!finished && (
                                <button
                                    onClick={handleCancel}
                                    disabled={isCancelling}
                                    className="px-4 py-2 rounded-full text-sm font-medium text-gray-400 hover:text-red-300 hover:bg-red-500/10 border border-white/10 transition-colors disabled:opacity-50"
                                >
                                    {isCancelling ? (
                                        <>
                                            <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-2" />
                                            Cancelling…
                                        </>
                                    ) : (
                                        "Cancel import"
                                    )}
                                </button>
                            )}

                            <Link
                                href="/import/spotify"
                                className="px-4 py-2 rounded-full text-sm font-medium text-gray-400 hover:text-white transition-colors"
                            >
                                Import another
                            </Link>
                        </div>

                        {/* Filters */}
                        <div className="flex flex-wrap items-center gap-2 mb-3">
                            {FILTERS.map((f) => {
                                const count = f.states
                                    ? detail.tracks.filter((t) =>
                                          f.states!.includes(t.state)
                                      ).length
                                    : detail.tracks.length;
                                return (
                                    <button
                                        key={f.id}
                                        onClick={() => setFilter(f.id)}
                                        className={
                                            "px-3 py-1.5 rounded-full text-xs font-medium transition-colors " +
                                            (filter === f.id
                                                ? "bg-white/15 text-white"
                                                : "text-gray-400 hover:text-white hover:bg-white/5")
                                        }
                                    >
                                        {f.label} ({count})
                                    </button>
                                );
                            })}
                        </div>

                        {/* Per-track list */}
                        <div className="bg-white/5 rounded-xl border border-white/10 divide-y divide-white/5">
                            {visibleTracks.length === 0 ? (
                                <p className="text-sm text-gray-500 px-4 py-8 text-center">
                                    No songs in this view.
                                </p>
                            ) : (
                                visibleTracks.map((track) => (
                                    <ImportTrackListRow
                                        key={track.index}
                                        track={track}
                                        onSkipDownload={(
                                            downloadJobId,
                                            trackCount
                                        ) => {
                                            if (
                                                trackCount > 1 &&
                                                !window.confirm(
                                                    `That download covers ${trackCount} songs in this import. Stop waiting for all of them?`
                                                )
                                            ) {
                                                return;
                                            }
                                            skipDownloads(
                                                [downloadJobId],
                                                downloadJobId
                                            );
                                        }}
                                        isSkipping={
                                            skippingId === "all" ||
                                            (!!track.downloadJobId &&
                                                skippingId ===
                                                    track.downloadJobId)
                                        }
                                    />
                                ))
                            )}
                        </div>

                        {finished && detail.summary.unresolved > 0 && (
                            <p className="text-xs text-gray-500 mt-4">
                                Unresolved songs stay attached to the playlist
                                and are matched automatically whenever the
                                library picks them up later.
                            </p>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

function SummaryCard({
    label,
    value,
    tone,
}: {
    label: string;
    value: number;
    tone: string;
}) {
    return (
        <div className="bg-white/5 rounded-lg p-3 border border-white/10">
            <p className={`text-xl font-bold ${tone}`}>{value}</p>
            <p className="text-xs text-gray-400">{label}</p>
        </div>
    );
}
