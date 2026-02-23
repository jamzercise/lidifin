import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { ArtistSource } from "../types";
import { useMemo, useEffect, useRef, useState } from "react";

export function useArtistData() {
    const params = useParams();
    const id = params.id as string;
    const { downloadStatus } = useDownloadContext();
    const prevActiveCountRef = useRef(downloadStatus.activeDownloads.length);

    // Use React Query - no polling needed, webhook events trigger refresh via download context
    const {
        data: artist,
        isLoading,
        isError,
        refetch,
    } = useQuery({
        queryKey: queryKeys.artist(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Artist ID is required");
            try {
                return await api.getArtist(id);
            } catch {
                // Never fall back to discovery for Jellyfin IDs - discovery would treat
                // "jellyfin:uuid" as an artist name and return garbage (ID as name)
                if (id.startsWith("jellyfin:")) {
                    throw new Error("Artist not found");
                }
                return await api.getArtistDiscovery(id);
            }
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    // Refetch when downloads complete (active count decreases)
    useEffect(() => {
        const currentActiveCount = downloadStatus.activeDownloads.length;
        if (
            prevActiveCountRef.current > 0 &&
            currentActiveCount < prevActiveCountRef.current
        ) {
            // Downloads have completed, refresh data
            refetch();
        }
        prevActiveCountRef.current = currentActiveCount;
    }, [downloadStatus.activeDownloads.length, refetch]);

    // Determine source from the artist data (if it came from library or discovery)
    const source: ArtistSource | null = useMemo(() => {
        if (!artist) return null;
        // Jellyfin artists (jellyfin:uuid) and CUIDs are from library
        if (artist.id?.startsWith("jellyfin:")) return "library";
        return artist.id && !artist.id.includes("-") ? "library" : "discovery";
    }, [artist]);

    // Sort state: 'year' or 'dateAdded'
    const [sortBy, setSortBy] = useState<"year" | "dateAdded">("year");

    // Sort albums by year or dateAdded (auto-memoized by React Compiler)
    const albums = !artist?.albums
        ? []
        : [...artist.albums].sort((a, b) => {
              if (sortBy === "dateAdded") {
                  if (!a.lastSynced && !b.lastSynced) return 0;
                  if (!a.lastSynced) return 1;
                  if (!b.lastSynced) return -1;
                  return (
                      new Date(b.lastSynced).getTime() -
                      new Date(a.lastSynced).getTime()
                  );
              } else {
                  if (a.year == null && b.year == null) return 0;
                  if (a.year == null) return 1;
                  if (b.year == null) return -1;
                  return b.year - a.year;
              }
          });

    // Handle errors - only show toast once, don't auto-navigate
    // The page component should handle displaying a "not found" state
    // Don't call router.back() as it causes navigation loops

    return {
        artist,
        albums,
        loading: isLoading,
        error: isError,
        source,
        sortBy,
        setSortBy,
        reloadArtist: refetch,
    };
}
