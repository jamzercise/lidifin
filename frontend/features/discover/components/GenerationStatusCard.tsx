"use client";

import { useState } from "react";
import {
    RefreshCw,
    RotateCcw,
    CheckCircle2,
    XCircle,
    Clock,
    AlertTriangle,
    ChevronDown,
    Trash2,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import type { BatchContext } from "../types";
import type { BatchStatus } from "../hooks/useDiscoverData";

interface GenerationStatusCardProps {
    batchContext: BatchContext | null;
    batchStatus: BatchStatus | null;
    isGenerating: boolean;
    /** True when a previous playlist is still visible below the card. */
    hasPlaylist: boolean;
    onRebuild: () => void;
    onGenerate: () => void;
    onCancel: () => void;
    onRetryAlbum: (jobId: string) => void;
    onDismissFailed: () => Promise<void>;
}

/**
 * Unified, compact status card for Discover Weekly generation. Replaces the
 * old full-page BatchContextView island and the separate regenerating banner
 * with a single purple-accented card: status line + progress bar + inline
 * actions, with the download queue tucked into a collapsed disclosure.
 */
export function GenerationStatusCard({
    batchContext,
    batchStatus,
    isGenerating,
    hasPlaylist,
    onRebuild,
    onGenerate,
    onCancel,
    onRetryAlbum,
    onDismissFailed,
}: GenerationStatusCardProps) {
    const [isQueueOpen, setIsQueueOpen] = useState(false);
    const [isRebuilding, setIsRebuilding] = useState(false);
    const [isCancelling, setIsCancelling] = useState(false);
    const [isClearing, setIsClearing] = useState(false);
    const [retryingId, setRetryingId] = useState<string | null>(null);

    // Prefer live polling data over the (possibly stale) batchContext snapshot
    const isActive =
        batchStatus?.active ??
        (batchContext?.status === "downloading" ||
            batchContext?.status === "scanning");
    const isScanning =
        (batchStatus?.status ?? batchContext?.status) === "scanning";

    const queue =
        batchStatus?.albums && batchStatus.albums.length > 0
            ? batchStatus.albums
            : batchContext?.recommendedAlbums ?? [];
    const total = batchStatus?.total ?? batchContext?.totalJobs ?? queue.length;

    const batchMode = batchStatus?.mode ?? batchContext?.mode ?? "album";
    const itemNoun = batchMode === "track" ? "songs" : "albums";

    const doneCount = queue.filter((a) => a.status === "completed").length;
    const failedCount = queue.filter(
        (a) => a.status === "failed" || a.status === "exhausted"
    ).length;
    const pendingCount = Math.max(0, total - doneCount - failedCount);
    const completed = batchStatus?.completed ?? doneCount;

    const hasSomeCompleted = (batchContext?.completedJobs ?? doneCount) > 0;
    const allFailed =
        !isActive &&
        total > 0 &&
        (batchContext
            ? batchContext.failedJobs === batchContext.totalJobs
            : failedCount === total);

    const title = isActive
        ? isScanning
            ? "Importing downloaded tracks…"
            : "Building your playlist…"
        : allFailed
            ? "All downloads failed"
            : hasSomeCompleted
                ? "Playlist couldn't be built"
                : "Generation ran into issues";

    const subtitle = isActive
        ? isScanning
            ? hasPlaylist
                ? "Almost done. Showing your current playlist until the new one is ready."
                : "Almost done — matching tracks to your library."
            : total > 0
                ? `Downloading ${itemNoun} — ${completed} of ${total}${
                      hasPlaylist
                          ? ". Showing your current playlist until the new one is ready."
                          : ""
                  }`
                : `Finding ${itemNoun} for you…`
        : batchContext?.errorMessage
            ? batchContext.errorMessage
            : hasSomeCompleted
                ? `${batchContext?.completedJobs ?? doneCount} ${itemNoun} downloaded but the tracks couldn't be matched to your library. Try rebuilding the playlist.`
                : `${batchContext?.failedJobs ?? failedCount} of ${total} downloads failed. You can try generating again.`;

    const progressPct =
        isActive && !isScanning && total > 0
            ? Math.min(100, Math.round((completed / total) * 100))
            : null;

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

    const handleClearFailedClick = async () => {
        setIsClearing(true);
        try {
            await onDismissFailed();
        } finally {
            setIsClearing(false);
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

    return (
        <div
            role="status"
            aria-live="polite"
            className="rounded-xl border border-purple-500/20 bg-purple-500/5 overflow-hidden"
        >
            {/* Status row */}
            <div className="flex items-center gap-3 px-4 py-3">
                <div className="shrink-0">
                    {isActive ? (
                        <GradientSpinner size="sm" />
                    ) : (
                        <AlertTriangle
                            className={cn(
                                "w-5 h-5",
                                allFailed ? "text-red-400" : "text-orange-400"
                            )}
                        />
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                        {title}
                    </p>
                    <p className="text-xs text-gray-400 truncate" title={subtitle}>
                        {subtitle}
                    </p>
                </div>

                {/* Inline actions */}
                <div className="flex items-center gap-2 shrink-0">
                    {isActive ? (
                        <button
                            onClick={handleCancelClick}
                            disabled={isCancelling}
                            className={cn(
                                "flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full transition-all",
                                isCancelling
                                    ? "bg-white/5 cursor-not-allowed opacity-50 text-gray-400"
                                    : "bg-white/5 hover:bg-red-500/10 border border-white/10 hover:border-red-500/30 text-gray-300 hover:text-red-300"
                            )}
                        >
                            {isCancelling ? (
                                <GradientSpinner size="sm" />
                            ) : (
                                <XCircle className="w-3.5 h-3.5" />
                            )}
                            Cancel
                        </button>
                    ) : (
                        <>
                            {hasSomeCompleted && (
                                <button
                                    onClick={handleRebuildClick}
                                    disabled={isRebuilding || isGenerating}
                                    className={cn(
                                        "flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full transition-all",
                                        isRebuilding || isGenerating
                                            ? "bg-white/5 cursor-not-allowed opacity-50 text-gray-400"
                                            : "bg-purple-600/20 hover:bg-purple-600/30 border border-purple-500/30 text-white"
                                    )}
                                >
                                    {isRebuilding ? (
                                        <GradientSpinner size="sm" />
                                    ) : (
                                        <RotateCcw className="w-3.5 h-3.5" />
                                    )}
                                    <span className="hidden sm:inline">
                                        Rebuild
                                    </span>
                                </button>
                            )}
                            <button
                                onClick={onGenerate}
                                disabled={isGenerating}
                                className={cn(
                                    "flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full transition-all",
                                    isGenerating
                                        ? "bg-white/5 cursor-not-allowed opacity-50 text-gray-400"
                                        : "bg-white/5 hover:bg-white/10 border border-white/10 text-white"
                                )}
                            >
                                {isGenerating ? (
                                    <GradientSpinner size="sm" />
                                ) : (
                                    <RefreshCw className="w-3.5 h-3.5" />
                                )}
                                <span className="hidden sm:inline">
                                    Generate New
                                </span>
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Progress bar */}
            {progressPct !== null && (
                <div className="px-4 pb-1">
                    <div className="h-1 rounded-full bg-white/10 overflow-hidden">
                        <div
                            className="h-full rounded-full bg-gradient-to-r from-purple-500 to-fuchsia-400 transition-[width] duration-500"
                            style={{ width: `${progressPct}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Queue disclosure */}
            {queue.length > 0 && (
                <div className="border-t border-white/5">
                    <div className="flex items-center justify-between gap-3 px-4 py-2">
                        <button
                            type="button"
                            onClick={() => setIsQueueOpen((v) => !v)}
                            aria-expanded={isQueueOpen}
                            className="flex items-center gap-2 text-xs font-medium text-white/60 hover:text-white transition-colors py-1"
                        >
                            <ChevronDown
                                className={cn(
                                    "w-3.5 h-3.5 transition-transform",
                                    isQueueOpen ? "rotate-0" : "-rotate-90"
                                )}
                            />
                            Queue ({total})
                            <span className="flex items-center gap-2 text-[11px] normal-case">
                                {doneCount > 0 && (
                                    <span className="text-green-400">
                                        {doneCount} done
                                    </span>
                                )}
                                {failedCount > 0 && (
                                    <span className="text-red-400">
                                        {failedCount} failed
                                    </span>
                                )}
                                {pendingCount > 0 && (
                                    <span className="text-yellow-400/80">
                                        {pendingCount} pending
                                    </span>
                                )}
                            </span>
                        </button>
                        {failedCount > 0 && (
                            <button
                                type="button"
                                onClick={handleClearFailedClick}
                                disabled={isClearing}
                                className={cn(
                                    "flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full shrink-0 transition-all",
                                    isClearing
                                        ? "bg-white/5 cursor-not-allowed opacity-50 text-gray-400"
                                        : "bg-white/5 hover:bg-red-500/10 border border-white/10 hover:border-red-500/30 text-gray-300 hover:text-red-300"
                                )}
                            >
                                {isClearing ? (
                                    <GradientSpinner size="sm" />
                                ) : (
                                    <Trash2 className="w-3 h-3" />
                                )}
                                Clear failed
                            </button>
                        )}
                    </div>

                    {isQueueOpen && (
                        <div className="px-2 pb-2 space-y-1 max-h-72 overflow-y-auto">
                            {queue.map((album, i) => {
                                const isFailed =
                                    album.status === "failed" ||
                                    album.status === "exhausted";
                                return (
                                    <div
                                        key={album.id ?? i}
                                        className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors"
                                    >
                                        <span className="text-xs text-gray-500 w-5 text-right tabular-nums shrink-0">
                                            {i + 1}
                                        </span>
                                        <span className="shrink-0">
                                            {statusIcon(album.status)}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm text-white truncate">
                                                {album.album}
                                                <span className="text-gray-500">
                                                    {" — "}
                                                    {album.artist}
                                                </span>
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
                                                onClick={() =>
                                                    handleRetryClick(album.id!)
                                                }
                                                disabled={
                                                    retryingId === album.id
                                                }
                                                aria-label={`Retry downloading ${album.album}`}
                                                className={cn(
                                                    "flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full shrink-0 transition-all",
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
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
