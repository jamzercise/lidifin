import { ApiClient, ApiData } from "./client";

declare module "./client" {
    interface ApiClient {
        search(query: string, type?: "all" | "artists" | "albums" | "tracks" | "audiobooks" | "podcasts", limit?: number, signal?: AbortSignal): Promise<ApiData>;
        discoverSearch(query: string, type?: "music" | "podcasts" | "all", limit?: number, signal?: AbortSignal): Promise<{ results: ApiData[]; aliasInfo: { original: string; canonical: string; mbid?: string } | null }>;
        discoverSimilarArtists(artist: string, mbid?: string, signal?: AbortSignal): Promise<{ similarArtists: ApiData[] }>;
    }
}

ApiClient.prototype.search = async function (
    this: ApiClient,
    query: string,
    type: "all" | "artists" | "albums" | "tracks" | "audiobooks" | "podcasts" = "all",
    limit: number = 20,
    signal?: AbortSignal
) {
    return this.request(
        `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
        { signal }
    );
};

ApiClient.prototype.discoverSearch = async function (
    this: ApiClient,
    query: string,
    type: "music" | "podcasts" | "all" = "music",
    limit: number = 20,
    signal?: AbortSignal
) {
    return this.request(
        `/search/discover?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}`,
        { signal }
    );
};

ApiClient.prototype.discoverSimilarArtists = async function (
    this: ApiClient,
    artist: string,
    mbid: string = "",
    signal?: AbortSignal
) {
    return this.request(
        `/search/discover/similar?artist=${encodeURIComponent(artist)}&mbid=${encodeURIComponent(mbid)}`,
        { signal }
    );
};
