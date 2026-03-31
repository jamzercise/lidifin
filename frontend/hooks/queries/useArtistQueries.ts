import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "./queryKeys";

/**
 * Hook to fetch artist data with automatic library/discovery fallback
 *
 * Tries library first, falls back to discovery if not found.
 * Cache time: 10 minutes (artist data rarely changes)
 *
 * @param id - Artist ID or MusicBrainz ID
 * @returns Query result with artist data
 *
 * @example
 * const { data: artist, isLoading, error } = useArtistQuery("artist-123");
 */
const artistQueryFn = async (id: string) => {
    if (!id) throw new Error("Artist ID is required");
    try {
        return await api.getArtist(id);
    } catch {
        if (id.startsWith("jellyfin:")) throw new Error("Artist not found");
        return await api.getArtistDiscovery(id);
    }
};

export function useArtistQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.artist(id || ""),
        queryFn: () => artistQueryFn(id!),
        enabled: !!id,
        staleTime: 10 * 60 * 1000, // 10 minutes
        retry: 1,
    });
}

/**
 * Prefetch artist data on hover for faster navigation.
 * For Jellyfin artists, also prefetches enrichment (bio, similar artists) in background.
 * Call prefetchArtist(routeId) or prefetchArtist(routeId, artist) from onMouseEnter on artist links.
 * @param routeId - Artist route ID (name, mbid, or jellyfin:uuid)
 * @param artist - Optional artist object; when artist.id starts with "jellyfin:", also prefetches enrichment
 */
export function usePrefetchArtist() {
    const queryClient = useQueryClient();
    return (routeId: string, artist?: { id?: string }) => {
        if (!routeId) return;
        queryClient.prefetchQuery({
            queryKey: queryKeys.artist(routeId),
            queryFn: () => artistQueryFn(routeId),
            staleTime: 10 * 60 * 1000,
        });
        // Background enrichment prefetch for Jellyfin artists – artist page often cached on first visit
        if (artist?.id?.startsWith("jellyfin:") || routeId.startsWith("jellyfin:")) {
            queryClient.prefetchQuery({
                queryKey: queryKeys.artistEnrichment(routeId),
                queryFn: () => api.getArtistEnrichment(routeId),
                staleTime: 10 * 60 * 1000,
            });
        }
    };
}

/**
 * Hook to fetch artist data from library only
 *
 * @param id - Artist ID
 * @returns Query result with artist data from library
 */
export function useArtistLibraryQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.artistLibrary(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Artist ID is required");
            return await api.getArtist(id);
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch artist data from discovery only
 *
 * @param id - Artist name or MusicBrainz ID
 * @returns Query result with artist data from Last.fm
 */
export function useArtistDiscoveryQuery(nameOrMbid: string | undefined) {
    return useQuery({
        queryKey: queryKeys.artistDiscovery(nameOrMbid || ""),
        queryFn: async () => {
            if (!nameOrMbid) throw new Error("Artist name or MBID is required");
            return await api.getArtistDiscovery(nameOrMbid);
        },
        enabled: !!nameOrMbid,
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}
