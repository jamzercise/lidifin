"use client";

import { useState } from "react";
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
import { UnavailableAlbums } from "@/features/discover/components/UnavailableAlbums";
import { HowItWorks } from "@/features/discover/components/HowItWorks";
import type { BatchContext } from "@/features/discover/types";
import type { BatchStatus } from "@/features/discover/hooks/useDiscoverData";

export default function DiscoverWeeklyPage() {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const [showSettings, setShowSettings] = useState(false);

    const { playlist, config, setConfig, loading, reloadData, batchStatus, refreshBatchStatus, setPendingGeneration, updateTrackLiked, isGenerating, handleRebuild } = useDiscoverData();
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
                            <TrackList
                                tracks={playlist.tracks}
                                currentTrack={currentTrack}
                                isPlaying={isPlaying}
                                onPlayTrack={handlePlayTrack}
                                onTogglePlay={handleTogglePlay}
                                onLike={handleLike}
                            />

                            <UnavailableAlbums
                                unavailable={playlist.unavailable}
                                currentPreview={currentPreview}
                                onTogglePreview={handleTogglePreview}
                            />

                            <HowItWorks />
                        </div>
                    ) : batchContext ? (
                        <BatchContextView
                            batchContext={batchContext}
                            isGenerating={isGenerating}
                            onRebuild={handleRebuild}
                            onGenerate={handleGenerate}
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

function BatchContextView({
    batchContext,
    isGenerating,
    onRebuild,
    onGenerate,
    batchStatus,
}: {
    batchContext: BatchContext;
    isGenerating: boolean;
    onRebuild: () => void;
    onGenerate: () => void;
    batchStatus: BatchStatus | null;
}) {
    const [isRebuilding, setIsRebuilding] = useState(false);

    const handleRebuildClick = async () => {
        setIsRebuilding(true);
        try {
            await onRebuild();
        } finally {
            setTimeout(() => setIsRebuilding(false), 3000);
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

    const isBatchStillActive = batchContext.status === "downloading" || batchContext.status === "scanning";
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
                    </div>
                </div>
            </div>

            {/* Recommended Albums List */}
            {batchContext.recommendedAlbums.length > 0 && (
                <div>
                    <h4 className="text-sm font-medium text-white/70 uppercase tracking-wider mb-4">
                        Recommended Albums ({batchContext.totalJobs})
                    </h4>
                    <div className="space-y-2">
                        {batchContext.recommendedAlbums.map((album, i) => (
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
                                </div>
                                <span className={cn(
                                    "text-xs px-2 py-0.5 rounded-full",
                                    album.status === "completed"
                                        ? "bg-green-500/10 text-green-400"
                                        : album.status === "failed" || album.status === "exhausted"
                                            ? "bg-red-500/10 text-red-400"
                                            : "bg-yellow-500/10 text-yellow-400"
                                )}>
                                    {album.status === "completed"
                                        ? "Downloaded"
                                        : album.status === "failed" || album.status === "exhausted"
                                            ? "Failed"
                                            : "Pending"
                                    }
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
