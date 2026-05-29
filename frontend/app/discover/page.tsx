"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Music2, RotateCcw, CheckCircle2, XCircle, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useAudioState, useAudioPlayback } from "@/lib/audio-context";
import { useDiscoverData } from "@/features/discover/hooks/useDiscoverData";
import { useDiscoverActions } from "@/features/discover/hooks/useDiscoverActions";
import { usePreviewPlayer } from "@/features/discover/hooks/usePreviewPlayer";
import { DiscoverHero } from "@/features/discover/components/DiscoverHero";
import { DiscoverActionBar } from "@/features/discover/components/DiscoverActionBar";
import { DiscoverSettings } from "@/features/discover/components/DiscoverSettings";
import { TrackList } from "@/features/discover/components/TrackList";
import { TrackFilters, type TrackSort } from "@/features/discover/components/TrackFilters";
import { UnavailableAlbums } from "@/features/discover/components/UnavailableAlbums";
import { HowItWorks } from "@/features/discover/components/HowItWorks";
import type { BatchContext } from "@/features/discover/types";
import type { BatchStatus } from "@/features/discover/hooks/useDiscoverData";

export default function DiscoverWeeklyPage() {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const [showSettings, setShowSettings] = useState(false);
    const [sortBy, setSortBy] = useState<TrackSort>("order");
    const [tierFilter, setTierFilter] = useState<string>("all");

    const { playlist, config, setConfig, loading, reloadData, batchStatus, refreshBatchStatus, setPendingGeneration, updateTrackLiked, isGenerating, handleRebuild, handleCancel, handleRetryAlbum } = useDiscoverData();
    const {
        handleGenerate,
        handleLike,
        handlePlayPlaylist,
        handlePlayTrack,
        handleTogglePlay,
    } = useDiscoverActions(playlist, reloadData, isGenerating, refreshBatchStatus, setPendingGeneration, updateTrackLiked);
    const { currentPreview, handleTogglePreview } = usePreviewPlayer();

    const isPlaylistPlaying = playlist?.tracks.some(
        (t) => t.id === currentTrack?.id
    );

    const TIER_ORDER: Record<string, number> = {
        high: 0,
        medium: 1,
        explore: 2,
        wildcard: 3,
    };

    const displayedTracks = useMemo(() => {
        if (!playlist) return [];
        let tracks = playlist.tracks;
        if (tierFilter !== "all") {
            tracks = tracks.filter((t) => t.tier === tierFilter);
        }
        if (sortBy === "match") {
            tracks = [...tracks].sort(
                (a, b) => (b.similarity || 0) - (a.similarity || 0)
            );
        } else if (sortBy === "tier") {
            tracks = [...tracks].sort(
                (a, b) =>
                    (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) ||
                    (b.similarity || 0) - (a.similarity || 0)
            );
        }
        return tracks;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- TIER_ORDER is a stable literal
    }, [playlist, sortBy, tierFilter]);

    // Map a row index in the (possibly filtered/sorted) displayed list back to
    // the original playlist index so the player queues the right track.
    const handlePlayDisplayedTrack = (displayIndex: number) => {
        const track = displayedTracks[displayIndex];
        if (!track || !playlist) return;
        const realIndex = playlist.tracks.findIndex((t) => t.id === track.id);
        handlePlayTrack(realIndex >= 0 ? realIndex : 0);
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    const batchContext = playlist?.batchContext;

    return (
        <div className="min-h-screen">
            <DiscoverHero playlist={playlist} config={config} />

            <DiscoverActionBar
                playlist={playlist}
                config={config}
                isPlaylistPlaying={isPlaylistPlaying || false}
                isPlaying={isPlaying}
                onPlayToggle={isPlaylistPlaying && isPlaying ? handleTogglePlay : handlePlayPlaylist}
                onGenerate={handleGenerate}
                onToggleSettings={() => setShowSettings(!showSettings)}
                isGenerating={isGenerating}
                batchStatus={batchStatus}
            />

            {showSettings && (
                <DiscoverSettings
                    config={config}
                    onUpdateConfig={setConfig}
                    onPlaylistCleared={reloadData}
                />
            )}

            {/* Track Listing */}
            <div className="px-4 md:px-8 pb-32">
                {playlist && playlist.tracks.length > 0 ? (
                        <div className="space-y-6">
                            {isGenerating && (
                                <RegeneratingBanner batchStatus={batchStatus} />
                            )}
                            <div
                                className={cn(
                                    "space-y-6 transition-opacity",
                                    isGenerating && "opacity-50"
                                )}
                                aria-busy={isGenerating}
                            >
                                <TrackFilters
                                    tracks={playlist.tracks}
                                    sortBy={sortBy}
                                    onSortChange={setSortBy}
                                    tierFilter={tierFilter}
                                    onTierChange={setTierFilter}
                                />
                                {displayedTracks.length > 0 ? (
                                    <TrackList
                                        tracks={displayedTracks}
                                        currentTrack={currentTrack}
                                        isPlaying={isPlaying}
                                        onPlayTrack={handlePlayDisplayedTrack}
                                        onTogglePlay={handleTogglePlay}
                                        onLike={handleLike}
                                    />
                                ) : (
                                    <p className="text-sm text-gray-500 px-4 py-8 text-center">
                                        No tracks match this filter.
                                    </p>
                                )}

                                <UnavailableAlbums
                                    unavailable={playlist.unavailable}
                                    currentPreview={currentPreview}
                                    onTogglePreview={handleTogglePreview}
                                />

                                <HowItWorks exclusionMonths={config?.exclusionMonths} />
                            </div>
                        </div>
                    ) : batchContext ? (
                        <BatchContextView
                            batchContext={batchContext}
                            isGenerating={isGenerating}
                            onRebuild={handleRebuild}
                            onGenerate={handleGenerate}
                            onCancel={handleCancel}
                            onRetryAlbum={handleRetryAlbum}
                            batchStatus={batchStatus}
                        />
                    ) : (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <div className="w-20 h-20 bg-gradient-to-br from-purple-600/20 to-yellow-600/20 rounded-full flex items-center justify-center mb-4 shadow-xl border border-white/10">
                                <Music2 className="w-10 h-10 text-purple-400" />
                            </div>
                            <h3 className="text-lg font-medium text-white mb-1">
                                No Discover Weekly Yet
                            </h3>
                            <p className="text-sm text-gray-500 mb-6 max-w-md">
                                Generate your first playlist based on your
                                listening history!
                            </p>
                            <button
                                onClick={handleGenerate}
                                disabled={isGenerating}
                                className={cn(
                                    "flex items-center gap-2 px-6 py-3 rounded-full text-white font-semibold transition-all",
                                    isGenerating
                                        ? "bg-white/5 cursor-not-allowed opacity-50"
                                        : "bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 hover:scale-105"
                                )}
                            >
                                {isGenerating ? (
                                    <>
                                        <GradientSpinner size="sm" />
                                        {batchStatus?.status === "scanning" 
                                            ? "Importing tracks..."
                                            : `Downloading... ${batchStatus?.completed || 0}/${batchStatus?.total || 0}`
                                        }
                                    </>
                                ) : (
                                    <>
                                        <RefreshCw className="w-5 h-5" />
                                        Generate Now
                                    </>
                                )}
                            </button>
                        </div>
                    )}
            </div>
        </div>
    );
}

function RegeneratingBanner({ batchStatus }: { batchStatus: BatchStatus | null }) {
    const detail =
        batchStatus?.status === "scanning"
            ? "Importing downloaded tracks…"
            : batchStatus?.total
                ? `Downloading albums… ${batchStatus.completed || 0}/${batchStatus.total}`
                : "Finding albums for you…";

    return (
        <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-xl border border-purple-500/20 bg-purple-500/5 px-4 py-3"
        >
            <GradientSpinner size="sm" />
            <div className="min-w-0">
                <p className="text-sm font-medium text-white">
                    Building a fresh playlist…
                </p>
                <p className="text-xs text-gray-400 truncate">
                    {detail} Showing your current playlist until the new one is
                    ready.
                </p>
            </div>
        </div>
    );
}

function BatchContextView({
    batchContext,
    isGenerating,
    onRebuild,
    onGenerate,
    onCancel,
    onRetryAlbum,
    batchStatus,
}: {
    batchContext: BatchContext;
    isGenerating: boolean;
    onRebuild: () => void;
    onGenerate: () => void;
    onCancel: () => void;
    onRetryAlbum: (jobId: string) => void;
    batchStatus: BatchStatus | null;
}) {
    const [isRebuilding, setIsRebuilding] = useState(false);
    const [isCancelling, setIsCancelling] = useState(false);
    const [retryingId, setRetryingId] = useState<string | null>(null);

    const handleRebuildClick = async () => {
        setIsRebuilding(true);
        try {
            await onRebuild();
        } finally {
            setTimeout(() => setIsRebuilding(false), 3000);
        }
    };

    const handleCancelClick = async () => {
        setIsCancelling(true);
        try {
            await onCancel();
        } finally {
            setIsCancelling(false);
        }
    };

    const handleRetryClick = async (jobId: string) => {
        setRetryingId(jobId);
        try {
            await onRetryAlbum(jobId);
        } finally {
            setTimeout(() => setRetryingId(null), 3000);
        }
    };

    const statusIcon = (status: string) => {
        switch (status) {
            case "completed":
                return <CheckCircle2 className="w-4 h-4 text-green-400" />;
            case "failed":
            case "exhausted":
                return <XCircle className="w-4 h-4 text-red-400" />;
            case "pending":
            case "processing":
                return <Clock className="w-4 h-4 text-yellow-400" />;
            default:
                return <Clock className="w-4 h-4 text-gray-400" />;
        }
    };

    // Prefer live polling data over the (possibly stale) batchContext snapshot
    const isBatchStillActive =
        batchStatus?.active ??
        (batchContext.status === "downloading" ||
            batchContext.status === "scanning");
    const liveAlbums =
        batchStatus?.albums && batchStatus.albums.length > 0
            ? batchStatus.albums
            : batchContext.recommendedAlbums;
    const totalAlbums = batchStatus?.total ?? batchContext.totalJobs;
    const hasSomeCompleted = batchContext.completedJobs > 0;
    const allFailed = batchContext.failedJobs === batchContext.totalJobs;

    return (
        <div className="max-w-2xl mx-auto py-12 space-y-8">
            {/* Status Banner */}
            <div className={cn(
                "rounded-xl border p-6",
                isBatchStillActive
                    ? "bg-yellow-500/5 border-yellow-500/20"
                    : allFailed
                        ? "bg-red-500/5 border-red-500/20"
                        : "bg-orange-500/5 border-orange-500/20"
            )}>
                <div className="flex items-start gap-4">
                    <div className={cn(
                        "w-10 h-10 rounded-full flex items-center justify-center shrink-0",
                        isBatchStillActive
                            ? "bg-yellow-500/20"
                            : allFailed
                                ? "bg-red-500/20"
                                : "bg-orange-500/20"
                    )}>
                        {isBatchStillActive ? (
                            <GradientSpinner size="sm" />
                        ) : (
                            <AlertTriangle className={cn(
                                "w-5 h-5",
                                allFailed ? "text-red-400" : "text-orange-400"
                            )} />
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <h3 className="text-white font-medium mb-1">
                            {isBatchStillActive
                                ? batchContext.status === "scanning"
                                    ? "Importing downloaded tracks..."
                                    : "Downloads in progress..."
                                : allFailed
                                    ? "All downloads failed"
                                    : hasSomeCompleted
                                        ? "Playlist couldn't be built"
                                        : "Generation ran into issues"
                            }
                        </h3>
                        <p className="text-sm text-gray-400">
                            {isBatchStillActive
                                ? "Your playlist is being prepared. This page will update automatically."
                                : batchContext.errorMessage
                                    ? batchContext.errorMessage
                                    : hasSomeCompleted
                                        ? `${batchContext.completedJobs} album(s) downloaded but the tracks couldn't be matched to your library. Try rebuilding the playlist.`
                                        : `${batchContext.failedJobs} of ${batchContext.totalJobs} downloads failed. You can try generating again.`
                            }
                        </p>

                        {/* Action buttons */}
                        {!isBatchStillActive && (
                            <div className="flex gap-3 mt-4">
                                {hasSomeCompleted && (
                                    <button
                                        onClick={handleRebuildClick}
                                        disabled={isRebuilding || isGenerating}
                                        className={cn(
                                            "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                                            isRebuilding || isGenerating
                                                ? "bg-white/5 cursor-not-allowed opacity-50 text-gray-400"
                                                : "bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-white hover:scale-105"
                                        )}
                                    >
                                        {isRebuilding ? (
                                            <>
                                                <GradientSpinner size="sm" />
                                                Rebuilding...
                                            </>
                                        ) : (
                                            <>
                                                <RotateCcw className="w-4 h-4" />
                                                Rebuild Playlist
                                            </>
                                        )}
                                    </button>
                                )}
                                <button
                                    onClick={onGenerate}
                                    disabled={isGenerating}
                                    className={cn(
                                        "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                                        isGenerating
                                            ? "bg-white/5 cursor-not-allowed opacity-50 text-gray-400"
                                            : "bg-white/5 hover:bg-white/10 border border-white/10 text-white hover:scale-105"
                                    )}
                                >
                                    {isGenerating ? (
                                        <>
                                            <GradientSpinner size="sm" />
                                            {batchStatus?.status === "scanning"
                                                ? "Importing..."
                                                : `Downloading... ${batchStatus?.completed || 0}/${batchStatus?.total || 0}`
                                            }
                                        </>
                                    ) : (
                                        <>
                                            <RefreshCw className="w-4 h-4" />
                                            Generate New
                                        </>
                                    )}
                                </button>
                            </div>
                        )}

                        {/* Cancel while a batch is actively running */}
                        {isBatchStillActive && (
                            <div className="mt-4">
                                <button
                                    onClick={handleCancelClick}
                                    disabled={isCancelling}
                                    className={cn(
                                        "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                                        isCancelling
                                            ? "bg-white/5 cursor-not-allowed opacity-50 text-gray-400"
                                            : "bg-white/5 hover:bg-red-500/10 border border-white/10 hover:border-red-500/30 text-gray-300 hover:text-red-300"
                                    )}
                                >
                                    {isCancelling ? (
                                        <>
                                            <GradientSpinner size="sm" />
                                            Cancelling...
                                        </>
                                    ) : (
                                        <>
                                            <XCircle className="w-4 h-4" />
                                            Cancel
                                        </>
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Recommended Albums List */}
            {liveAlbums.length > 0 && (
                <div>
                    <h4 className="text-sm font-medium text-white/70 uppercase tracking-wider mb-4">
                        Recommended Albums ({totalAlbums})
                    </h4>
                    <div className="space-y-2">
                        {liveAlbums.map((album, i) => {
                            const isFailed =
                                album.status === "failed" ||
                                album.status === "exhausted";
                            return (
                                <div
                                    key={i}
                                    className="flex items-center gap-3 px-4 py-3 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
                                >
                                    <span className="text-sm text-gray-500 w-6 text-right tabular-nums">
                                        {i + 1}
                                    </span>
                                    {statusIcon(album.status)}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm text-white truncate">
                                            {album.album}
                                        </p>
                                        <p className="text-xs text-gray-500 truncate">
                                            {album.artist}
                                        </p>
                                        {isFailed && album.error && (
                                            <p
                                                className="text-xs text-red-400/80 truncate"
                                                title={album.error}
                                            >
                                                {album.error}
                                            </p>
                                        )}
                                    </div>
                                    {isFailed && album.id && (
                                        <button
                                            onClick={() => handleRetryClick(album.id!)}
                                            disabled={retryingId === album.id}
                                            aria-label={`Retry downloading ${album.album}`}
                                            className={cn(
                                                "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full shrink-0 transition-all",
                                                retryingId === album.id
                                                    ? "bg-white/5 cursor-not-allowed opacity-50 text-gray-400"
                                                    : "bg-white/5 hover:bg-purple-600/20 border border-white/10 hover:border-purple-500/30 text-gray-300 hover:text-white"
                                            )}
                                        >
                                            {retryingId === album.id ? (
                                                <GradientSpinner size="sm" />
                                            ) : (
                                                <RotateCcw className="w-3 h-3" />
                                            )}
                                            Retry
                                        </button>
                                    )}
                                    <span className={cn(
                                        "text-xs px-2 py-0.5 rounded-full shrink-0",
                                        album.status === "completed"
                                            ? "bg-green-500/10 text-green-400"
                                            : isFailed
                                                ? "bg-red-500/10 text-red-400"
                                                : "bg-yellow-500/10 text-yellow-400"
                                    )}>
                                        {album.status === "completed"
                                            ? "Downloaded"
                                            : isFailed
                                                ? "Failed"
                                                : "Pending"
                                        }
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
