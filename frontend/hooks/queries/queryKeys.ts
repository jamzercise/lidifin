export const queryKeys = {
    // Artist queries
    artist: (id: string) => ["artist", id] as const,
    artistEnrichment: (id: string) => ["artist", "enrichment", id] as const,
    artistLibrary: (id: string) => ["artist", "library", id] as const,
    artistDiscovery: (id: string) => ["artist", "discovery", id] as const,

    // Album queries
    album: (id: string) => ["album", id] as const,
    albumLibrary: (id: string) => ["album", "library", id] as const,
    albumDiscovery: (id: string) => ["album", "discovery", id] as const,
    albums: (filters?: Record<string, unknown>) => ["albums", filters] as const,

    // Library queries
    library: () => ["library"] as const,
    libraryArtists: (params: {
        filter?: string;
        sortBy?: string;
        limit?: number;
        offset?: number;
    }) => ["library", "artists", params] as const,
    libraryAlbums: (params: {
        filter?: string;
        sortBy?: string;
        limit?: number;
        offset?: number;
    }) => ["library", "albums", params] as const,
    libraryTracks: (params: {
        sortBy?: string;
        limit?: number;
        offset?: number;
    }) => ["library", "tracks", params] as const,
    recentlyListened: (limit?: number) =>
        ["library", "recently-listened", limit] as const,
    recentlyAdded: (limit?: number) =>
        ["library", "recently-added", limit] as const,

    // Recommendations
    recommendations: (limit?: number) => ["recommendations", limit] as const,
    becauseYouListened: (limit?: number) =>
        ["recommendations", "because-you-listened", limit] as const,
    similarArtists: (seedArtistId: string, limit?: number) =>
        ["recommendations", "artists", seedArtistId, limit] as const,
    similarAlbums: (seedAlbumId: string, limit?: number) =>
        ["recommendations", "albums", seedAlbumId, limit] as const,

    // Search
    search: (query: string, type?: string, limit?: number) =>
        ["search", query, type, limit] as const,
    discoverSearch: (query: string, type?: string, limit?: number) =>
        ["search", "discover", query, type, limit] as const,
    discoverSimilar: (artist: string, mbid: string) =>
        ["search", "discover", "similar", artist, mbid] as const,

    // Playlists
    playlists: () => ["playlists"] as const,
    playlist: (id: string) => ["playlist", id] as const,

    // Mixes
    mixes: () => ["mixes"] as const,
    mix: (id: string) => ["mix", id] as const,

    // Popular artists
    popularArtists: (limit?: number) => ["popular-artists", limit] as const,

    // Audiobooks
    audiobooks: () => ["audiobooks"] as const,
    audiobook: (id: string) => ["audiobook", id] as const,

    // Podcasts
    podcasts: () => ["podcasts"] as const,
    podcast: (id: string) => ["podcast", id] as const,
    topPodcasts: (limit?: number, genreId?: number) =>
        ["podcasts", "top", limit, genreId] as const,
    newEpisodes: (limit?: number) =>
        ["podcasts", "new-episodes", limit] as const,
    podcastContinueListening: (limit?: number) =>
        ["podcasts", "continue-listening", limit] as const,

    // Browse (Deezer playlists/radios)
    browseAll: () => ["browse", "all"] as const,
    browseFeatured: (limit?: number) => ["browse", "featured", limit] as const,
    browseRadios: (limit?: number) => ["browse", "radios", limit] as const,

    savedDiscoveryAlbums: (params?: { limit?: number; offset?: number }) =>
        ["discover", "saved-albums", params] as const,

    /** Paginated infinite list for `/library/saved-albums` */
    savedDiscoveryAlbumsInfinite: (pageSize: number) =>
        ["discover", "saved-albums", "paged", pageSize] as const,
};
