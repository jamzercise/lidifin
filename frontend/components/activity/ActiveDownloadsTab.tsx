"use client";

import { useState } from "react";
import { Download, Loader2, Music, Disc, X } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "../ui/GradientSpinner";
import { useActiveDownloads } from "@/hooks/useNotifications";

export function ActiveDownloadsTab() {
    // Use shared React Query hook instead of duplicate polling
    const { downloads, isLoading: loading, refetch } = useActiveDownloads();
    const [cancelling, setCancelling] = useState<Set<string>>(new Set());

    const handleCancel = async (id: string) => {
        setCancelling((prev) => new Set(prev).add(id));
        try {
            await api.deleteDownload(id);
            // Refetch to get updated list
            refetch();
        } catch (error) {
            console.error("Failed to cancel download:", error);
        } finally {
            setCancelling((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const handleCancelAll = async () => {
        const ids = downloads.map((d) => d.id);
        setCancelling(new Set(ids));
        try {
            // Cancel all downloads in parallel
            await Promise.all(ids.map((id) => api.deleteDownload(id)));
            refetch();
        } catch (error) {
            console.error("Failed to cancel all downloads:", error);
            refetch();
        } finally {
            setCancelling(new Set());
        }
    };

    const formatTime = (dateStr: string) => {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();

        if (diff < 60000) return "Just started";
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
        return date.toLocaleDateString();
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
            </div>
        );
    }

    if (downloads.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-12 text-center">
                <Download className="w-8 h-8 text-white/20 mb-3" />
                <p className="text-sm text-white/40">No active downloads</p>
                <p className="text-xs text-white/30 mt-1">
                    Downloads will appear here
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                <span className="text-xs text-white/40">
                    {downloads.length} downloading
                </span>
                <div className="flex items-center gap-3">
                    <button
                        onClick={handleCancelAll}
                        className="text-xs text-white/40 hover:text-red-400 transition-colors"
                        title="Cancel all downloads"
                    >
                        Cancel all
                    </button>
                    <span className="flex items-center gap-1.5 text-xs text-green-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                        Active
                    </span>
                </div>
            </div>

            {/* Download list */}
            <div className="flex-1 overflow-y-auto">
                {downloads.map((download) => (
                    <div
                        key={download.id}
                        className="px-3 py-3 border-b border-white/5 hover:bg-white/5 transition-colors group"
                    >
                        <div className="flex items-start gap-3">
                            <div className="mt-0.5 shrink-0">
                                {cancelling.has(download.id) ? (
                                    <Loader2 className="w-4 h-4 text-white/40 animate-spin" />
                                ) : (
                                    <GradientSpinner size="sm" />
                                )}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white truncate">
                                    {download.subject}
                                </p>
                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                    <span
                                        className={cn(
                                            "text-xs font-medium capitalize",
                                            download.status === "processing"
                                                ? "text-blue-400"
                                                : "text-yellow-400"
                                        )}
                                    >
                                        {download.status}
                                    </span>
                                    {Boolean(download.metadata?.statusText) && (
                                        <>
                                            <span className="text-xs text-white/30">
                                                •
                                            </span>
                                            <span
                                                className={cn(
                                                    "text-xs font-medium",
                                                    download.metadata
                                                        ?.currentSource ===
                                                        "lidarr"
                                                        ? "text-purple-400"
                                                        : "text-teal-400"
                                                )}
                                            >
                                                {String(download.metadata?.statusText)}
                                            </span>
                                        </>
                                    )}
                                    <span className="text-xs text-white/30">
                                        •
                                    </span>
                                    <span className="text-xs text-white/30 capitalize flex items-center gap-1">
                                        {download.type === "album" ? (
                                            <Disc className="w-3 h-3" />
                                        ) : (
                                            <Music className="w-3 h-3" />
                                        )}
                                        {download.type}
                                    </span>
                                    <span className="text-xs text-white/30">
                                        •
                                    </span>
                                    <span className="text-xs text-white/30">
                                        {formatTime(download.createdAt)}
                                    </span>
                                </div>
                                {/* Soulseek: search summary and progress */}
                                {download.metadata?.currentSource ===
                                    "soulseek" && (
                                    <div className="mt-2 space-y-1.5">
                                        {Boolean(
                                            download.metadata
                                                .soulseekSearchQuery
                                        ) && (
                                            <p className="text-xs text-white/50 truncate">
                                                Search:{" "}
                                                {String(download.metadata.soulseekSearchQuery)}
                                            </p>
                                        )}
                                        {download.metadata.soulseekPhase ===
                                            "searching" && (
                                            <p className="text-xs text-white/40">
                                                Searching…
                                            </p>
                                        )}
                                        {download.metadata.soulseekMatchesFound !=
                                            null &&
                                            download.metadata
                                                .soulseekTracksTotal !=
                                                null && (
                                            <p className="text-xs text-white/40">
                                                Found{" "}
                                                {String(download.metadata.soulseekMatchesFound)}
                                                /
                                                {String(download.metadata.soulseekTracksTotal)}{" "}
                                                results
                                            </p>
                                        )}
                                        {(download.metadata
                                            .soulseekTracksTotal != null &&
                                            Number(download.metadata.soulseekTracksTotal) > 0 &&
                                            (download.metadata
                                                .soulseekTracksDownloaded !=
                                                null ||
                                                download.metadata
                                                    .tracksDownloaded !=
                                                    null)) && (
                                            <div className="flex items-center gap-2">
                                                <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full bg-teal-500/80 transition-all duration-300"
                                                        style={{
                                                            width: `${Math.min(
                                                                100,
                                                                (100 *
                                                                    (Number(download.metadata?.soulseekTracksDownloaded) ||
                                                                        Number(download.metadata?.tracksDownloaded) ||
                                                                        0)) /
                                                                    (Number(download.metadata?.soulseekTracksTotal) ||
                                                                        Number(download.metadata?.tracksTotal) ||
                                                                        1)
                                                            )}%`,
                                                        }}
                                                    />
                                                </div>
                                                <span className="text-xs text-white/40 tabular-nums shrink-0">
                                                    {Number(download.metadata?.soulseekTracksDownloaded) ||
                                                        Number(download.metadata?.tracksDownloaded) ||
                                                        0}
                                                    /
                                                    {Number(download.metadata?.soulseekTracksTotal) ||
                                                        Number(download.metadata?.tracksTotal) ||
                                                        0}{" "}
                                                    tracks
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={() => handleCancel(download.id)}
                                disabled={cancelling.has(download.id)}
                                className="p-1 opacity-0 group-hover:opacity-100 hover:bg-white/10 rounded transition-all shrink-0"
                                title="Cancel download"
                            >
                                <X className="w-4 h-4 text-white/40 hover:text-red-400" />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
