"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type ImportStatus =
    | "pending"
    | "downloading"
    | "scanning"
    | "creating_playlist"
    | "matching_tracks"
    | "completed"
    | "failed"
    | "cancelled";

/**
 * An import job as returned by /spotify/imports/active — the full job minus the
 * pendingTracks payload.
 */
export interface ActiveImport {
    id: string;
    spotifyPlaylistId: string;
    playlistName: string;
    status: ImportStatus;
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number;
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

export const ACTIVE_IMPORTS_QUERY_KEY = ["active-imports"] as const;

const TERMINAL_IMPORT_STATUSES: ReadonlySet<ImportStatus> = new Set([
    "completed",
    "failed",
    "cancelled",
]);

export function isImportFinished(status: ImportStatus): boolean {
    return TERMINAL_IMPORT_STATUSES.has(status);
}

/**
 * Human-readable label for the phase an import is currently in.
 */
export function importStatusLabel(status: ImportStatus): string {
    switch (status) {
        case "downloading":
            return "Queueing album downloads";
        case "scanning":
            return "Scanning library";
        case "creating_playlist":
            return "Creating playlist";
        case "matching_tracks":
            return "Waiting for downloads";
        case "pending":
            return "Starting import";
        case "completed":
            return "Completed";
        case "failed":
            return "Failed";
        case "cancelled":
            return "Cancelled";
    }
}

/**
 * In-flight playlist imports, polled so an import stays visible after a refresh
 * or a navigation away from the import page. Shared cache means the import page
 * and the Activity panel always agree on what is running.
 */
export function useActiveImports() {
    const queryClient = useQueryClient();

    const fetchActiveImports = useCallback(
        () => api.get<ActiveImport[]>("/spotify/imports/active"),
        []
    );

    const {
        data: imports = [],
        isLoading,
        error,
        refetch,
    } = useQuery<ActiveImport[]>({
        queryKey: ACTIVE_IMPORTS_QUERY_KEY,
        queryFn: fetchActiveImports,
        // Tight while something is running so progress feels live, relaxed when
        // idle since we're only watching for an import started elsewhere.
        refetchInterval: (query) =>
            query.state.data && query.state.data.length > 0 ? 2000 : 20000,
        refetchIntervalInBackground: false,
        placeholderData: keepPreviousData,
        retry: 0,
    });

    /**
     * Drop a job from the cache immediately once it reaches a terminal state, so
     * the Activity panel doesn't keep showing it until the next poll lands.
     */
    const forget = useCallback(
        (jobId: string) => {
            queryClient.setQueryData<ActiveImport[]>(
                ACTIVE_IMPORTS_QUERY_KEY,
                (old) => old?.filter((job) => job.id !== jobId) ?? []
            );
        },
        [queryClient]
    );

    return {
        imports,
        isLoading,
        error: error instanceof Error ? error.message : null,
        refetch,
        forget,
    };
}
