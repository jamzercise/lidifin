import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "./queryKeys";

/**
 * Hook to fetch album data with automatic library/discovery fallback
 *
 * Cache time: 10 minutes (album data rarely changes)
 *
 * @param id - Album ID or Release Group MBID
 * @returns Query result with album data
 *
 * @example
 * const { data: album, isLoading, error } = useAlbumQuery("album-123");
 */
const albumQueryFn = async (id: string) => {
    if (!id) throw new Error("Album ID is required");
    try {
        return await api.getAlbum(id);
    } catch {
        return await api.getAlbumDiscovery(id);
    }
};

export function useAlbumQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.album(id || ""),
        queryFn: () => albumQueryFn(id!),
        enabled: !!id,
        staleTime: 10 * 60 * 1000, // 10 minutes
        retry: 1,
    });
}

/**
 * Prefetch album data on hover for faster navigation.
 * Call prefetchAlbum(id) from onMouseEnter on album links.
 */
export function usePrefetchAlbum() {
    const queryClient = useQueryClient();
    return (albumId: string) => {
        if (!albumId) return;
        queryClient.prefetchQuery({
            queryKey: queryKeys.album(albumId),
            queryFn: () => albumQueryFn(albumId),
            staleTime: 10 * 60 * 1000,
        });
    };
}

/**
 * Hook to fetch album data from library only
 *
 * @param id - Album ID
 * @returns Query result with album data from library
 */
export function useAlbumLibraryQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.albumLibrary(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Album ID is required");
            return await api.getAlbum(id);
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch album data from discovery only
 *
 * @param rgMbid - Release Group MusicBrainz ID
 * @returns Query result with album data from Last.fm
 */
export function useAlbumDiscoveryQuery(rgMbid: string | undefined) {
    return useQuery({
        queryKey: queryKeys.albumDiscovery(rgMbid || ""),
        queryFn: async () => {
            if (!rgMbid) throw new Error("Album MBID is required");
            return await api.getAlbumDiscovery(rgMbid);
        },
        enabled: !!rgMbid,
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch albums list with optional filters
 *
 * @param params - Filter parameters (artistId, limit, offset)
 * @returns Query result with albums array
 *
 * @example
 * const { data } = useAlbumsQuery({ artistId: "123", limit: 20 });
 */
export function useAlbumsQuery(params?: {
    artistId?: string;
    limit?: number;
    offset?: number;
}) {
    return useQuery({
        queryKey: queryKeys.albums(params),
        queryFn: () => api.getAlbums(params),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}
