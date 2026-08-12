"use client";

import {
    AlertCircle,
    Check,
    CircleDashed,
    Library,
    Loader2,
    XCircle,
} from "lucide-react";
import type { ImportTrackRow as TrackRow } from "@/hooks/useActiveImports";

/**
 * How each per-track state is presented. Kept in one table so the label, colour
 * and icon can't drift apart between the list and the summary.
 */
const STATE_PRESENTATION: Record<
    TrackRow["state"],
    { label: string; className: string; Icon: typeof Check }
> = {
    in_library: {
        label: "In library",
        className: "text-[#B1D2C3]",
        Icon: Library,
    },
    downloaded: {
        label: "Downloaded",
        className: "text-[#1DB954]",
        Icon: Check,
    },
    downloading: {
        label: "Downloading",
        className: "text-[#B1D2C3]",
        Icon: Loader2,
    },
    queued: {
        label: "Queued",
        className: "text-gray-400",
        Icon: CircleDashed,
    },
    download_failed: {
        label: "Download failed",
        className: "text-red-400",
        Icon: XCircle,
    },
    no_source: {
        label: "No source",
        className: "text-amber-400",
        Icon: AlertCircle,
    },
    unmatched: {
        label: "Not added",
        className: "text-amber-400",
        Icon: AlertCircle,
    },
};

export function ImportTrackStateBadge({ state }: { state: TrackRow["state"] }) {
    const { label, className, Icon } = STATE_PRESENTATION[state];
    return (
        <span
            className={`inline-flex items-center gap-1.5 text-xs font-medium ${className}`}
        >
            <Icon
                className={`w-3.5 h-3.5 shrink-0 ${
                    state === "downloading" ? "animate-spin" : ""
                }`}
            />
            {label}
        </span>
    );
}

interface ImportTrackRowProps {
    track: TrackRow;
    /** Called with the download this track waits on, to stop waiting for it. */
    onSkipDownload?: (downloadJobId: string, trackCount: number) => void;
    isSkipping?: boolean;
}

export function ImportTrackListRow({
    track,
    onSkipDownload,
    isSkipping,
}: ImportTrackRowProps) {
    const isWaiting =
        track.state === "downloading" || track.state === "queued";
    const canSkip = isWaiting && !!track.downloadJobId && !!onSkipDownload;

    return (
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/5 transition-colors">
            <div className="min-w-0 flex-1">
                <p className="text-sm text-white truncate">{track.title}</p>
                <p className="text-xs text-gray-400 truncate">
                    {track.artist}
                    {track.album ? ` • ${track.album}` : ""}
                </p>
                {track.detail && (
                    <p className="text-xs text-gray-500 truncate mt-0.5">
                        {track.detail}
                    </p>
                )}
            </div>

            <div className="shrink-0 flex items-center gap-3">
                <ImportTrackStateBadge state={track.state} />
                {canSkip && (
                    <button
                        onClick={() =>
                            onSkipDownload!(
                                track.downloadJobId!,
                                track.downloadTrackCount
                            )
                        }
                        disabled={isSkipping}
                        className="px-2.5 py-1 rounded-full text-xs font-medium text-gray-400 hover:text-white hover:bg-white/10 border border-white/10 transition-colors disabled:opacity-50"
                        title={
                            track.downloadTrackCount > 1
                                ? `Stop waiting for this album download (affects ${track.downloadTrackCount} songs)`
                                : "Stop waiting for this download"
                        }
                    >
                        {isSkipping ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                            "Stop waiting"
                        )}
                    </button>
                )}
            </div>
        </div>
    );
}
