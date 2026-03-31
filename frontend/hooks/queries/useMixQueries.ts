import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "./queryKeys";

interface PlaylistPreview {
    id: string;
    source: string;
    type: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

/**
 * Hook to fetch all mixes (Made For You)
 *
 * Cache time: 5 minutes
 *
 * @returns Query result with mixes array
 *
 * @example
 * const { data: mixes } = useMixesQuery();
 */
export function useMixesQuery() {
    return useQuery({
        queryKey: queryKeys.mixes(),
        queryFn: () => api.getMixes(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch a single mix
 *
 * @param id - Mix ID
 * @returns Query result with mix data
 */
export function useMixQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.mix(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Mix ID is required");
            return await api.getMix(id);
        },
        enabled: !!id,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to refresh mixes with cache invalidation
 *
 * @returns Mutation object with mutate function
 *
 * @example
 * const { mutate: refreshMixes, isPending } = useRefreshMixesMutation();
 * refreshMixes();
 */
export function useRefreshMixesMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: () => api.refreshMixes(),
        onSuccess: () => {
            // Invalidate mixes query to refetch
            queryClient.invalidateQueries({ queryKey: queryKeys.mixes() });
        },
    });
}

/**
 * Hook to fetch radio stations from Deezer
 *
 * @param limit - Maximum number of radios to fetch
 * @returns Query result with radio stations
 */
export function useRadiosQuery(limit: number = 50) {
    return useQuery({
        queryKey: queryKeys.browseRadios(limit),
        queryFn: async (): Promise<PlaylistPreview[]> => {
            const response = await api.get<{ radios: PlaylistPreview[] }>(
                `/browse/radios?limit=${limit}`,
            );
            return response.radios;
        },
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}
