import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "./queryKeys";

/**
 * Hook to fetch all subscribed podcasts
 *
 * @returns Query result with podcasts array
 */
export function usePodcastsQuery() {
    return useQuery({
        queryKey: queryKeys.podcasts(),
        queryFn: () => api.getPodcasts(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch a single podcast
 *
 * Returns null if podcast is not found (404), allowing the page to handle preview mode.
 *
 * @param id - Podcast ID
 * @returns Query result with podcast data
 */
export function usePodcastQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.podcast(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Podcast ID is required");

            try {
                return await api.getPodcast(id);
            } catch (error) {
                // If podcast not found (404), return null to allow preview mode
                const err = error as { status?: number; message?: string };
                if (
                    err?.status === 404 ||
                    err?.message?.includes("not found") ||
                    err?.message?.includes("not subscribed")
                ) {
                    return null;
                }
                // For other errors, throw to trigger error state
                throw error;
            }
        },
        enabled: !!id,
        staleTime: 5 * 60 * 1000, // 5 minutes
        retry: false, // Don't retry 404 errors
    });
}

/**
 * Hook to fetch top podcasts
 *
 * @param limit - Number of podcasts (default: 20)
 * @param genreId - Optional genre ID filter
 * @returns Query result with top podcasts
 */
export function useTopPodcastsQuery(limit: number = 20, genreId?: number) {
    return useQuery({
        queryKey: queryKeys.topPodcasts(limit, genreId),
        queryFn: () => api.getTopPodcasts(limit, genreId),
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch new unplayed episodes from subscribed podcasts (≤14 days old, <1% played)
 */
export function useNewEpisodesQuery(limit: number = 20) {
    return useQuery({
        queryKey: queryKeys.newEpisodes(limit),
        queryFn: () => api.getNewEpisodes(limit),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch partially played podcast episodes for continue listening
 */
export function usePodcastContinueListeningQuery(limit: number = 20) {
    return useQuery({
        queryKey: queryKeys.podcastContinueListening(limit),
        queryFn: () => api.getPodcastContinueListening(limit),
        staleTime: 2 * 60 * 1000, // 2 minutes (progress changes frequently)
    });
}
