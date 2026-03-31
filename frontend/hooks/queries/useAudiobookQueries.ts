import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "./queryKeys";

/**
 * Hook to fetch all audiobooks
 *
 * @returns Query result with audiobooks array
 */
export function useAudiobooksQuery() {
    return useQuery({
        queryKey: queryKeys.audiobooks(),
        queryFn: () => api.getAudiobooks(),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch a single audiobook
 *
 * @param id - Audiobook ID
 * @returns Query result with audiobook data
 */
export function useAudiobookQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.audiobook(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Audiobook ID is required");
            return await api.getAudiobook(id);
        },
        enabled: !!id,
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}
