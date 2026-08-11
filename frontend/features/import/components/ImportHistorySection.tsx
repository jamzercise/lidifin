"use client";

import { useState } from "react";
import Link from "next/link";
import {
    ListMusic,
    Loader2,
    Check,
    AlertCircle,
    Ban,
    ChevronRight,
} from "lucide-react";
import {
    useImportHistory,
    isImportFinished,
    importStatusLabel,
    type ActiveImport,
} from "@/hooks/useActiveImports";
import { formatRelativeTime } from "@/utils/formatRelativeTime";

const COLLAPSED_COUNT = 3;

/**
 * The most useful secondary number for the state an import is in.
 */
function importDetail(job: ActiveImport): string | null {
    switch (job.status) {
        case "completed":
            return job.tracksTotal > 0
                ? `${job.tracksMatched} of ${job.tracksTotal} songs added`
                : null;
        case "failed":
            return job.error || null;
        case "cancelled":
            return null;
        default:
            return job.albumsTotal > 0
                ? `${job.albumsCompleted}/${job.albumsTotal} albums`
                : null;
    }
}

function StatusIcon({ status }: { status: ActiveImport["status"] }) {
    if (!isImportFinished(status)) {
        return (
            <Loader2 className="w-4 h-4 text-[#B1D2C3] animate-spin shrink-0" />
        );
    }
    if (status === "completed") {
        return <Check className="w-4 h-4 text-green-400 shrink-0" />;
    }
    if (status === "failed") {
        return <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />;
    }
    return <Ban className="w-4 h-4 text-gray-500 shrink-0" />;
}

function ImportRow({ job }: { job: ActiveImport }) {
    const running = !isImportFinished(job.status);
    const detail = importDetail(job);

    // A running import goes back to its progress view; a finished one is most
    // useful as the playlist it produced.
    const href = running
        ? `/import/spotify?job=${encodeURIComponent(job.id)}`
        : job.createdPlaylistId
        ? `/playlist/${job.createdPlaylistId}`
        : null;

    const body = (
        <div className="flex items-center gap-3 px-4 py-3">
            <StatusIcon status={job.status} />
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm text-white truncate">
                        {job.playlistName}
                    </span>
                    <span className="text-xs text-white/30 shrink-0">
                        {formatRelativeTime(job.createdAt)}
                    </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span
                        className={
                            running
                                ? "text-xs font-medium text-[#B1D2C3]"
                                : job.status === "failed"
                                ? "text-xs font-medium text-red-400"
                                : "text-xs font-medium text-gray-400"
                        }
                    >
                        {importStatusLabel(job.status)}
                    </span>
                    {detail && (
                        <>
                            <span className="text-xs text-white/20">·</span>
                            <span className="text-xs text-gray-500 truncate">
                                {detail}
                            </span>
                        </>
                    )}
                </div>
                {running && (
                    <div className="flex items-center gap-2 mt-2">
                        <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                            <div
                                className="h-full rounded-full bg-[#B1D2C3] transition-all duration-500"
                                style={{
                                    width: `${Math.min(
                                        100,
                                        Math.max(0, job.progress)
                                    )}%`,
                                }}
                            />
                        </div>
                        <span className="text-xs text-white/40 tabular-nums shrink-0">
                            {job.progress}%
                        </span>
                    </div>
                )}
            </div>
            {href && <ChevronRight className="w-4 h-4 text-gray-600 shrink-0" />}
        </div>
    );

    if (!href) {
        return (
            <div className="border-b border-white/5 last:border-0">{body}</div>
        );
    }

    return (
        <Link
            href={href}
            className="block border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors"
        >
            {body}
        </Link>
    );
}

/**
 * Progress and history for playlist imports, shown where imports are started so
 * they don't only live in the Activity panel.
 */
export function ImportHistorySection() {
    const { imports, error } = useImportHistory();
    const [showAll, setShowAll] = useState(false);

    // Supplementary panel: if it can't load, stay out of the way rather than
    // putting an error banner on the import page. The Activity panel still has it.
    if (error || imports.length === 0) return null;

    const runningCount = imports.filter(
        (job) => !isImportFinished(job.status)
    ).length;
    const visible = showAll ? imports : imports.slice(0, COLLAPSED_COUNT);

    return (
        <div className="mb-6 rounded-lg bg-white/5 border border-white/10 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <div className="flex items-center gap-2">
                    <ListMusic className="w-4 h-4 text-[#B1D2C3]" />
                    <h2 className="text-sm font-medium text-white">
                        Your imports
                    </h2>
                    {runningCount > 0 && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-[#B1D2C3]/20 text-[#B1D2C3]">
                            {runningCount} running
                        </span>
                    )}
                </div>
                {imports.length > COLLAPSED_COUNT && (
                    <button
                        onClick={() => setShowAll((prev) => !prev)}
                        className="text-xs text-[#B1D2C3] hover:underline"
                    >
                        {showAll
                            ? "Show less"
                            : `Show all ${imports.length}`}
                    </button>
                )}
            </div>
            <div>
                {visible.map((job) => (
                    <ImportRow key={job.id} job={job} />
                ))}
            </div>
        </div>
    );
}
