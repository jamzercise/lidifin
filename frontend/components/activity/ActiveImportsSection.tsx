"use client";

import Link from "next/link";
import { ListMusic } from "lucide-react";
import {
    importStatusLabel,
    type ActiveImport,
} from "@/hooks/useActiveImports";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

/**
 * The most useful secondary number for the phase the import is in.
 */
function importDetail(job: ActiveImport): string | null {
    if (
        job.albumsTotal > 0 &&
        (job.status === "downloading" || job.status === "matching_tracks")
    ) {
        return `${job.albumsCompleted}/${job.albumsTotal} albums`;
    }
    if (job.status === "creating_playlist" && job.tracksTotal > 0) {
        return `${job.tracksMatched}/${job.tracksTotal} tracks`;
    }
    return null;
}

interface ActiveImportsSectionProps {
    imports: ActiveImport[];
}

/**
 * In-flight playlist imports, shown above active downloads so an import stays
 * visible from anywhere in the app rather than only on the import page.
 */
export function ActiveImportsSection({ imports }: ActiveImportsSectionProps) {
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    // On small screens the panel is a full-screen overlay, so it has to get out
    // of the way when we navigate to the import page.
    const closePanelOnNavigate = isMobile || isTablet;

    if (imports.length === 0) return null;

    return (
        <div>
            {imports.map((job) => {
                const detail = importDetail(job);

                return (
                    <Link
                        key={job.id}
                        href={`/import/job/${encodeURIComponent(job.id)}`}
                        onClick={() => {
                            if (closePanelOnNavigate) {
                                window.dispatchEvent(
                                    new CustomEvent("close-activity-panel")
                                );
                            }
                        }}
                        className="block px-3 py-3 border-b border-white/5 hover:bg-white/5 transition-colors"
                    >
                        <div className="flex items-start gap-3">
                            <ListMusic className="w-4 h-4 text-[#B1D2C3] mt-0.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium text-white truncate">
                                    {job.playlistName}
                                </p>
                                <div className="flex items-center gap-2 mt-1 flex-wrap">
                                    <span className="text-xs font-medium text-[#B1D2C3]">
                                        {importStatusLabel(job.status)}
                                    </span>
                                    <span className="text-xs text-white/30">
                                        •
                                    </span>
                                    <span className="text-xs text-white/30">
                                        Playlist import
                                    </span>
                                    {detail && (
                                        <>
                                            <span className="text-xs text-white/30">
                                                •
                                            </span>
                                            <span className="text-xs text-white/30">
                                                {detail}
                                            </span>
                                        </>
                                    )}
                                </div>
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
                            </div>
                        </div>
                    </Link>
                );
            })}
        </div>
    );
}
