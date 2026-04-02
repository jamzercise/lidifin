import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { Artist, Album, Track } from "@/features/library/types";
import { queryKeys } from "./queryKeys";

export type LibraryFilter = "owned" | "discovery" | "all";
export type SortOption = "name" | "name-desc" | "recent" | "tracks";

interface LibraryArtistsParams {
    filter?: LibraryFilter;
    sortBy?: SortOption;
    limit?: number;
    page?: number;
    enabled?: boolean;
}

interface LibraryAlbumsParams {
    filter?: LibraryFilter;
    sortBy?: SortOption;
    limit?: number;
    page?: number;
    enabled?: boolean;
}

interface LibraryTracksParams {
    sortBy?: SortOption;
    limit?: number;
    page?: number;
    enabled?: boolean;
}

// Page response types for infinite queries
interface ArtistsPageResponse {
    artists: Artist[];
    total: number;
    offset: number;
    limit: number;
}

interface AlbumsPageResponse {
    albums: Album[];
    total: number;
    offset: number;
    limit: number;
}

interface TracksPageResponse {
    tracks: Track[];
    total: number;
    offset: number;
    limit: number;
}

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

interface Genre {
    id: number;
    name: string;
    picture?: string;
}

interface BrowseAllResponse {
    playlists: PlaylistPreview[];
    radios: PlaylistPreview[];
    genres: Genre[];
}

/**
 * Hook to fetch recently listened items (Continue Listening)
 *
 * Cache time: 2 minutes (may change frequently)
 *
 * @param limit - Number of items to fetch (default: 10)
 * @returns Query result with recently listened items
 *
 * @example
 * const { data } = useRecentlyListenedQuery(10);
 */
export function useRecentlyListenedQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recentlyListened(limit),
        queryFn: () => api.getRecentlyListened(limit),
        staleTime: 2 * 60 * 1000, // 2 minutes
    });
}

/**
 * Hook to fetch recently added artists
 *
 * Cache time: 2 minutes (may change as user adds music)
 *
 * @param limit - Number of items to fetch (default: 10)
 * @returns Query result with recently added artists
 *
 * @example
 * const { data } = useRecentlyAddedQuery(10);
 */
export function useRecentlyAddedQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recentlyAdded(limit),
        queryFn: () => api.getRecentlyAdded(limit),
        staleTime: 2 * 60 * 1000, // 2 minutes
    });
}

/**
 * Hook to fetch library artists with pagination and filtering
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
export function useLibraryArtistsQuery({
    filter = "owned",
    sortBy = "name",
    limit = 40,
    page = 1,
    enabled = true,
}: LibraryArtistsParams = {}) {
    const offset = (page - 1) * limit;
    return useQuery({
        queryKey: queryKeys.libraryArtists({ filter, sortBy, limit, offset }),
        queryFn: () => api.getArtists({ limit, offset, filter, sortBy }),
        select: (response) => ({
            artists: response.artists,
            total: response.total,
            offset: response.offset,
            limit: response.limit,
        }),
        staleTime: 2 * 60 * 1000,
        enabled,
        // Add structural sharing to prevent unnecessary re-renders
        structuralSharing: true,
        // Use placeholder data for better perceived performance
        placeholderData: (previousData) => previousData,
    });
}

/**
 * Hook to fetch library albums with infinite pagination and filtering
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
export function useLibraryAlbumsInfiniteQuery(
    {
        filter = "owned",
        sortBy = "name",
        limit = 40,
        enabled = true,
    }: Omit<LibraryAlbumsParams, 'page'> & { enabled?: boolean } = {},
) {
    return useInfiniteQuery<AlbumsPageResponse, Error, { pages: AlbumsPageResponse[], pageParams: number[] }, readonly unknown[], number>({
        queryKey: queryKeys.libraryAlbums({ filter, sortBy, limit }),
        queryFn: async ({ pageParam }) => {
            const offset = (pageParam - 1) * limit;
            const response = await api.getAlbums({ limit, offset, filter, sortBy });
            return {
                albums: response.albums,
                total: response.total,
                offset: response.offset,
                limit: response.limit,
            };
        },
        getNextPageParam: (lastPage: AlbumsPageResponse, allPages: AlbumsPageResponse[]) => {
            const totalItems = lastPage.total;
            const fetchedItems = allPages.flatMap(page => page.albums).length;
            return fetchedItems < totalItems ? allPages.length + 1 : undefined;
        },
        initialPageParam: 1,
        enabled,
    });
}

/**
 * Hook to fetch library artists with infinite pagination and filtering
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
export function useLibraryArtistsInfiniteQuery(
    {
        filter = "owned",
        sortBy = "name",
        limit = 40,
        enabled = true,
    }: Omit<LibraryArtistsParams, 'page'> & { enabled?: boolean } = {},
) {
    return useInfiniteQuery<ArtistsPageResponse, Error, { pages: ArtistsPageResponse[], pageParams: number[] }, readonly unknown[], number>({
        queryKey: queryKeys.libraryArtists({ filter, sortBy, limit }),
        queryFn: async ({ pageParam }) => {
            const offset = (pageParam - 1) * limit;
            const response = await api.getArtists({ limit, offset, filter, sortBy });
            return {
                artists: response.artists,
                total: response.total,
                offset: response.offset,
                limit: response.limit,
            };
        },
        getNextPageParam: (lastPage: ArtistsPageResponse, allPages: ArtistsPageResponse[]) => {
            const totalItems = lastPage.total;
            const fetchedItems = allPages.flatMap(page => page.artists).length;
            return fetchedItems < totalItems ? allPages.length + 1 : undefined;
        },
        initialPageParam: 1,
        enabled,
    });
}

/**
 * Hook to fetch library albums with pagination and filtering
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
export function useLibraryAlbumsQuery({
    filter = "owned",
    sortBy = "name",
    limit = 40,
    page = 1,
    enabled = true,
}: LibraryAlbumsParams = {}) {
    const offset = (page - 1) * limit;
    return useQuery({
        queryKey: queryKeys.libraryAlbums({ filter, sortBy, limit, offset }),
        queryFn: () => api.getAlbums({ limit, offset, filter, sortBy }),
        select: (response) => ({
            albums: response.albums,
            total: response.total,
            offset: response.offset,
            limit: response.limit,
        }),
        staleTime: 2 * 60 * 1000,
        enabled,
    });
}

/**
 * Hook to fetch library tracks with infinite pagination
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
export function useLibraryTracksInfiniteQuery(
    {
        sortBy = "name",
        limit = 40,
        enabled = true,
    }: Omit<LibraryTracksParams, 'page'> & { enabled?: boolean } = {},
) {
    return useInfiniteQuery<TracksPageResponse, Error, { pages: TracksPageResponse[], pageParams: number[] }, readonly unknown[], number>({
        queryKey: queryKeys.libraryTracks({ sortBy, limit }),
        queryFn: async ({ pageParam }) => {
            const offset = (pageParam - 1) * limit;
            const response = await api.getTracks({ limit, offset, sortBy });
            return {
                tracks: response.tracks,
                total: response.total,
                offset: response.offset,
                limit: response.limit,
            };
        },
        getNextPageParam: (lastPage: TracksPageResponse, allPages: TracksPageResponse[]) => {
            const totalItems = lastPage.total;
            const fetchedItems = allPages.flatMap(page => page.tracks).length;
            return fetchedItems < totalItems ? allPages.length + 1 : undefined;
        },
        initialPageParam: 1,
        enabled,
    });
}

/**
 * Hook to fetch library tracks with pagination
 *
 * Cache time: 2 minutes (may change as user adds music)
 */
export function useLibraryTracksQuery({
    sortBy = "name",
    limit = 40,
    page = 1,
    enabled = true,
}: LibraryTracksParams = {}) {
    const offset = (page - 1) * limit;
    return useQuery({
        queryKey: queryKeys.libraryTracks({ sortBy, limit, offset }),
        queryFn: () => api.getTracks({ limit, offset, sortBy }),
        select: (response) => ({
            tracks: response.tracks,
            total: response.total,
            offset: response.offset,
            limit: response.limit,
        }),
        staleTime: 2 * 60 * 1000,
        enabled,
    });
}

/**
 * Hook to fetch personalized recommendations
 *
 * Cache time: 5 minutes
 *
 * @param limit - Number of recommendations (default: 10)
 * @returns Query result with recommended artists
 *
 * @example
 * const { data } = useRecommendationsQuery(10);
 */
export function useRecommendationsQuery(limit: number = 10) {
    return useQuery({
        queryKey: queryKeys.recommendations(limit),
        queryFn: () => api.getRecommendationsForYou(limit),
        staleTime: 5 * 60 * 1000, // 5 minutes
    });
}

/**
 * Hook to fetch "Because You Listened To..." personalized sections
 *
 * @param limit - Number of seed artist sections (default: 3)
 * @returns Query result with grouped recommendations
 */
export function useBecauseYouListenedQuery(limit: number = 3) {
    return useQuery({
        queryKey: queryKeys.becauseYouListened(limit),
        queryFn: () => api.getBecauseYouListened(limit),
        staleTime: 10 * 60 * 1000, // 10 minutes — changes less frequently
    });
}

/**
 * Hook to fetch similar artists based on a seed artist
 *
 * @param seedArtistId - Artist ID to find similar artists for
 * @param limit - Number of recommendations (default: 20)
 * @returns Query result with similar artists
 *
 * @example
 * const { data } = useSimilarArtistsQuery("artist-123", 20);
 */
export function useSimilarArtistsQuery(
    seedArtistId: string | undefined,
    limit: number = 20,
) {
    return useQuery({
        queryKey: queryKeys.similarArtists(seedArtistId || "", limit),
        queryFn: async () => {
            if (!seedArtistId) throw new Error("Seed artist ID is required");
            return await api.getSimilarArtists(seedArtistId, limit);
        },
        enabled: !!seedArtistId,
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch similar albums based on a seed album
 *
 * @param seedAlbumId - Album ID to find similar albums for
 * @param limit - Number of recommendations (default: 20)
 * @returns Query result with similar albums
 */
export function useSimilarAlbumsQuery(
    seedAlbumId: string | undefined,
    limit: number = 20,
) {
    return useQuery({
        queryKey: queryKeys.similarAlbums(seedAlbumId || "", limit),
        queryFn: async () => {
            if (!seedAlbumId) throw new Error("Seed album ID is required");
            return await api.getSimilarAlbums(seedAlbumId, limit);
        },
        enabled: !!seedAlbumId,
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch popular artists from Last.fm
 *
 * Cache time: 10 minutes (popular charts don't change frequently)
 *
 * @param limit - Number of artists to fetch (default: 20)
 * @returns Query result with popular artists
 *
 * @example
 * const { data } = usePopularArtistsQuery(20);
 */
export function usePopularArtistsQuery(limit: number = 20) {
    return useQuery({
        queryKey: queryKeys.popularArtists(limit),
        queryFn: () => api.getPopularArtists(limit),
        staleTime: 10 * 60 * 1000, // 10 minutes
    });
}

/**
 * Hook to fetch all browse content (playlists, radios, genres) from Deezer
 *
 * @returns Query result with all browse content
 */
export function useBrowseAllQuery() {
    return useQuery({
        queryKey: queryKeys.browseAll(),
        queryFn: async (): Promise<BrowseAllResponse> => {
            return api.get<BrowseAllResponse>("/browse/all");
        },
        staleTime: 10 * 60 * 1000, // 10 minutes - playlists don't change often
    });
}
