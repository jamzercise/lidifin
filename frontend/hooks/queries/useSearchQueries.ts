import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "./queryKeys";

/**
 * Hook to search library with debouncing
 *
 * Cache time: 5 minutes (search results are relatively static)
 *
 * @param query - Search query string
 * @param type - Type filter (all, artists, albums, tracks, audiobooks, podcasts)
 * @param limit - Number of results per type (default: 20)
 * @returns Query result with search results
 *
 * @example
 * const { data } = useSearchQuery("radiohead", "all", 20);
 */
export function useSearchQuery(
    query: string,
    type:
        | "all"
        | "artists"
        | "albums"
        | "tracks"
        | "playlists"
        | "audiobooks"
        | "podcasts" = "all",
    limit: number = 20,
) {
    return useQuery({
        queryKey: queryKeys.search(query, type, limit),
        queryFn: ({ signal }) => api.search(query, type, limit, signal),
        enabled: query.length >= 2,
        staleTime: 2 * 60 * 1000,
        gcTime: 5 * 60 * 1000,
        placeholderData: keepPreviousData,
    });
}

export function useDiscoverSearchQuery(
    query: string,
    type: "music" | "podcasts" | "all" = "music",
    limit: number = 20,
) {
    return useQuery({
        queryKey: queryKeys.discoverSearch(query, type, limit),
        queryFn: ({ signal }) => api.discoverSearch(query, type, limit, signal),
        enabled: query.length >= 2,
        staleTime: 10 * 60 * 1000,
        gcTime: 15 * 60 * 1000,
        placeholderData: keepPreviousData,
    });
}

/**
 * Hook to fetch musically similar artists for a given artist.
 * Fires only when artistName is non-empty (i.e. after discover results load).
 */
export function useDiscoverSimilarArtistsQuery(artistName: string, mbid: string = "") {
    return useQuery({
        queryKey: queryKeys.discoverSimilar(artistName, mbid),
        queryFn: ({ signal }) => api.discoverSimilarArtists(artistName, mbid, signal),
        enabled: artistName.length > 0,
        staleTime: 30 * 60 * 1000, // 30 minutes -- similar artists rarely change
    });
}
