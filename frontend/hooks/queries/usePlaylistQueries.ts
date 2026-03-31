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
 * Hook to fetch all playlists
 *
 * Cache time: 1 minute (playlists may be actively modified)
 *
 * @returns Query result with playlists array
 *
 * @example
 * const { data: playlists } = usePlaylistsQuery();
 */
export function usePlaylistsQuery() {
    return useQuery({
        queryKey: queryKeys.playlists(),
        queryFn: () => api.getPlaylists(),
        staleTime: 30 * 1000, // 30 seconds - playlists change frequently when editing
        refetchOnWindowFocus: true, // Refetch when user returns to tab (e.g. after editing elsewhere)
    });
}

/**
 * Hook to fetch a single playlist
 *
 * @param id - Playlist ID
 * @returns Query result with playlist data
 *
 * @example
 * const { data: playlist } = usePlaylistQuery("playlist-123");
 */
export function usePlaylistQuery(id: string | undefined) {
    return useQuery({
        queryKey: queryKeys.playlist(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Playlist ID is required");
            return await api.getPlaylist(id);
        },
        enabled: !!id,
        staleTime: 1 * 60 * 1000, // 1 minute
    });
}

/**
 * Hook to add track to playlist with cache invalidation
 *
 * @returns Mutation object with mutate function
 *
 * @example
 * const { mutate: addToPlaylist } = useAddToPlaylistMutation();
 * addToPlaylist({ playlistId: "123", trackId: "456" });
 */
export function useAddToPlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            playlistId,
            trackId,
        }: {
            playlistId: string;
            trackId: string;
        }) => api.addTrackToPlaylist(playlistId, trackId),
        onSuccess: (_, variables) => {
            // Invalidate the specific playlist query
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlist(variables.playlistId),
            });
            // Also invalidate the playlists list
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
            // Notify Sidebar and other listeners to refresh
            window.dispatchEvent(
                new CustomEvent("playlist-updated", {
                    detail: { playlistId: variables.playlistId },
                })
            );
        },
    });
}

/**
 * Hook to create a new playlist with cache invalidation
 *
 * @returns Mutation object with mutate function
 *
 * @example
 * const { mutate: createPlaylist } = useCreatePlaylistMutation();
 * createPlaylist({ name: "My Playlist", isPublic: false });
 */
export function useCreatePlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: ({
            name,
            isPublic,
        }: {
            name: string;
            isPublic?: boolean;
        }) => api.createPlaylist(name, isPublic),
        onSuccess: () => {
            // Invalidate playlists list to show new playlist
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        },
    });
}

/**
 * Hook to delete a playlist with cache invalidation
 *
 * @returns Mutation object with mutate function
 *
 * @example
 * const { mutate: deletePlaylist } = useDeletePlaylistMutation();
 * deletePlaylist("playlist-123");
 */
export function useDeletePlaylistMutation() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (playlistId: string) => api.deletePlaylist(playlistId),
        onSuccess: () => {
            // Invalidate playlists list
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists(),
            });
        },
    });
}

/**
 * Hook to fetch featured playlists from Deezer
 *
 * @param limit - Maximum number of playlists to fetch
 * @returns Query result with featured playlists
 */
export function useFeaturedPlaylistsQuery(limit: number = 50) {
    return useQuery({
        queryKey: queryKeys.browseFeatured(limit),
        queryFn: async (): Promise<PlaylistPreview[]> => {
            const response = await api.get<{ playlists: PlaylistPreview[] }>(
                `/browse/playlists/featured?limit=${limit}`,
            );
            return response.playlists;
        },
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}
