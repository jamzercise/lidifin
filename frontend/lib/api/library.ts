import { ApiClient, ApiData, toSearchParams } from "./client";

declare module "./client" {
    interface ApiClient {
        getArtists(params?: { limit?: number; offset?: number; filter?: "owned" | "discovery" | "all"; sortBy?: string }): Promise<{ artists: ApiData[]; total: number; offset: number; limit: number }>;
        getRecentlyListened(limit?: number): Promise<{ items: ApiData[] }>;
        getRecentlyAdded(limit?: number): Promise<{ albums: Array<{ id: string; title: string; coverArt?: string | null; year?: number; rgMbid?: string | null; artist?: { id: string; name: string } }> }>;
        scanLibrary(): Promise<{ message: string; jobId: string; musicPath: string }>;
        getScanStatus(jobId: string): Promise<{ status: string; progress: number; result?: ApiData }>;
        organizeLibrary(): Promise<{ message: string }>;
        getArtist(id: string): Promise<ApiData>;
        getArtistEnrichment(id: string): Promise<{
            bio: string | null;
            image: string | null;
            genres: string[];
            listeners?: number;
            playcount?: number;
            similarArtists: Array<{ id: string; name: string; mbid: string | null; url?: string; image: string | null }>;
            discoveryAlbums: ApiData[];
            topTracks: Array<{ id: string; title: string; duration: number; artist?: { id: string; name: string }; album?: { id: string; title: string; coverArt: string | null } }>;
        }>;
        getAlbums(params?: { artistId?: string; limit?: number; offset?: number; filter?: "owned" | "discovery" | "all"; sortBy?: string }): Promise<{ albums: ApiData[]; total: number; offset: number; limit: number }>;
        getAlbum(id: string): Promise<ApiData>;
        getTracks(params?: { albumId?: string; limit?: number; offset?: number; sortBy?: string }): Promise<{ tracks: ApiData[]; total: number; offset: number; limit: number }>;
        getShuffledTracks(limit?: number): Promise<{ tracks: ApiData[]; total: number }>;
        deleteTrack(trackId: string): Promise<{ message: string }>;
        deleteAlbum(albumId: string): Promise<{ message: string; deletedFiles?: number }>;
        deleteArtist(artistId: string): Promise<{ message: string; deletedFiles?: number }>;
        getTrack(id: string): Promise<ApiData>;
        getRadioTracks(type: string, value?: string, limit?: number): Promise<{ tracks: ApiData[] }>;
        getStreamUrl(trackId: string): string;
        getStreamUrlForCast(trackId: string): string;
        getCoverArtUrlForCast(coverId: string, size?: number): string;
        getCoverArtUrl(coverId: string, size?: number, includeToken?: boolean): string;
        getFavorites(): Promise<{ tracks: ApiData[] }>;
        addFavorite(trackId: string): Promise<{ success: boolean; favorited: boolean }>;
        removeFavorite(trackId: string): Promise<{ success: boolean; favorited: boolean }>;
        syncJellyfinMetadata(): Promise<{ success: boolean; message?: string; status?: "syncing" | "enriching" }>;
        enrichJellyfinMetadata(): Promise<{ success: boolean; message?: string; status?: "enriching" }>;
        getJellyfinMetadataStatus(): Promise<{
            status: "idle" | "syncing" | "enriching";
            startedAt?: number;
            lastError?: string;
            lastSynced?: number;
            lastRemoved?: number;
            lastEnriched?: number;
            lastDurationMs?: number;
        }>;
        getRecommendationsForYou(limit?: number): Promise<{ artists: ApiData[] }>;
        getSimilarArtists(seedArtistId: string, limit?: number): Promise<{ recommendations: ApiData[] }>;
        getSimilarAlbums(seedAlbumId: string, limit?: number): Promise<{ recommendations: ApiData[] }>;
        getSimilarTracks(seedTrackId: string, limit?: number): Promise<{ recommendations: ApiData[] }>;
        getPopularArtists(limit?: number): Promise<{ artists: ApiData[] }>;
    }
}

ApiClient.prototype.getArtists = async function (this: ApiClient, params?) {
    return this.request(`/library/artists?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
};

ApiClient.prototype.getRecentlyListened = async function (this: ApiClient, limit = 10) {
    return this.request(`/library/recently-listened?limit=${limit}`);
};

ApiClient.prototype.getRecentlyAdded = async function (this: ApiClient, limit = 10) {
    return this.request(`/library/recently-added?limit=${limit}`);
};

ApiClient.prototype.scanLibrary = async function (this: ApiClient) {
    return this.request("/library/scan", { method: "POST" });
};

ApiClient.prototype.getScanStatus = async function (this: ApiClient, jobId: string) {
    return this.request(`/library/scan/status/${jobId}`);
};

ApiClient.prototype.organizeLibrary = async function (this: ApiClient) {
    return this.request("/library/organize", { method: "POST" });
};

ApiClient.prototype.getArtist = async function (this: ApiClient, id: string) {
    return this.request(`/library/artists/${encodeURIComponent(id)}`);
};

ApiClient.prototype.getArtistEnrichment = async function (this: ApiClient, id: string) {
    return this.request(`/library/artists/${encodeURIComponent(id)}/enrichment`);
};

ApiClient.prototype.getAlbums = async function (this: ApiClient, params?) {
    return this.request(`/library/albums?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
};

ApiClient.prototype.getAlbum = async function (this: ApiClient, id: string) {
    return this.request(`/library/albums/${encodeURIComponent(id)}`);
};

ApiClient.prototype.getTracks = async function (this: ApiClient, params?) {
    return this.request(`/library/tracks?${toSearchParams(params as Record<string, string | number | boolean | undefined>).toString()}`);
};

ApiClient.prototype.getShuffledTracks = async function (this: ApiClient, limit?: number) {
    const params = limit ? `?limit=${limit}` : "";
    return this.request(`/library/tracks/shuffle${params}`);
};

ApiClient.prototype.deleteTrack = async function (this: ApiClient, trackId: string) {
    return this.request(`/library/tracks/${trackId}`, { method: "DELETE" });
};

ApiClient.prototype.deleteAlbum = async function (this: ApiClient, albumId: string) {
    return this.request(`/library/albums/${albumId}`, { method: "DELETE" });
};

ApiClient.prototype.deleteArtist = async function (this: ApiClient, artistId: string) {
    return this.request(`/library/artists/${artistId}`, { method: "DELETE" });
};

ApiClient.prototype.getTrack = async function (this: ApiClient, id: string) {
    return this.request(`/library/tracks/${id}`);
};

ApiClient.prototype.getRadioTracks = async function (this: ApiClient, type: string, value?: string, limit = 50) {
    const params = new URLSearchParams({ type, limit: String(limit) });
    if (value) params.append("value", value);
    return this.request(`/library/radio?${params.toString()}`);
};

ApiClient.prototype.getStreamUrl = function (this: ApiClient, trackId: string): string {
    const baseUrl = `${this.getBaseUrl()}/api/library/tracks/${encodeURIComponent(trackId)}/stream`;
    const token = this.getCurrentToken();
    if (token) {
        return `${baseUrl}?token=${encodeURIComponent(token)}`;
    }
    return baseUrl;
};

ApiClient.prototype.getStreamUrlForCast = function (this: ApiClient, trackId: string): string {
    const base = this.getBaseUrlForCast();
    const path = `/api/library/tracks/${encodeURIComponent(trackId)}/stream`;
    const token = this.getCurrentToken();
    const url = base ? `${base}${path}` : `${path}`;
    if (token) {
        return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    }
    return url;
};

ApiClient.prototype.getCoverArtUrlForCast = function (this: ApiClient, coverId: string, size?: number): string {
    const url = this.getCoverArtUrl(coverId, size ?? 300);
    if (url.startsWith("http://") || url.startsWith("https://")) {
        return url;
    }
    const base = this.getBaseUrlForCast();
    return base ? `${base}${url.startsWith("/") ? "" : "/"}${url}` : url;
};

ApiClient.prototype.getCoverArtUrl = function (this: ApiClient, coverId: string, size?: number, includeToken = true): string {
    const baseUrl = this.getBaseUrl();
    const token = includeToken ? this.getCurrentToken() : null;

    // Check if this is an audiobook cover path (served by audiobooks endpoint, not proxied)
    if (coverId && coverId.startsWith("/audiobooks/")) {
        const url = `${baseUrl}/api${coverId}`;
        if (token) {
            return `${url}?token=${encodeURIComponent(token)}`;
        }
        return url;
    }

    // Check if this is a podcast cover path (served by podcasts endpoint, not proxied)
    if (coverId && coverId.startsWith("/podcasts/")) {
        const url = `${baseUrl}/api${coverId}`;
        if (token) {
            return `${url}?token=${encodeURIComponent(token)}`;
        }
        return url;
    }

    // Check if coverId is an external URL (needs to be proxied)
    // Also handle native: paths which need URL encoding
    if (
        coverId &&
        (coverId.startsWith("http://") ||
            coverId.startsWith("https://") ||
            coverId.startsWith("native:"))
    ) {
        // Pass as query parameter to avoid URL encoding issues
        const params = new URLSearchParams({ url: coverId });
        if (size) params.append("size", size.toString());
        if (token) params.append("token", token);
        return `${baseUrl}/api/library/cover-art?${params.toString()}`;
    }

    // Otherwise use as path parameter (cover ID - typically a hash)
    const params = new URLSearchParams();
    if (size) params.append("size", size.toString());
    if (token) params.append("token", token);
    const queryString = params.toString();
    return `${baseUrl}/api/library/cover-art/${encodeURIComponent(coverId)}${
        queryString ? "?" + queryString : ""
    }`;
};

ApiClient.prototype.getFavorites = async function (this: ApiClient) {
    return this.request("/library/favorites");
};

ApiClient.prototype.addFavorite = async function (this: ApiClient, trackId: string) {
    return this.request(`/library/favorites/${encodeURIComponent(trackId)}`, { method: "POST" });
};

ApiClient.prototype.removeFavorite = async function (this: ApiClient, trackId: string) {
    return this.request(`/library/favorites/${encodeURIComponent(trackId)}`, { method: "DELETE" });
};

ApiClient.prototype.syncJellyfinMetadata = async function (this: ApiClient) {
    return this.request("/library/jellyfin-metadata/sync", { method: "POST" });
};

ApiClient.prototype.enrichJellyfinMetadata = async function (this: ApiClient) {
    return this.request("/library/jellyfin-metadata/enrich", { method: "POST" });
};

ApiClient.prototype.getJellyfinMetadataStatus = async function (this: ApiClient) {
    return this.request("/library/jellyfin-metadata/status");
};

ApiClient.prototype.getRecommendationsForYou = async function (this: ApiClient, limit = 10) {
    return this.request(`/recommendations/for-you?limit=${limit}`);
};

ApiClient.prototype.getSimilarArtists = async function (this: ApiClient, seedArtistId: string, limit = 20) {
    return this.request(`/recommendations?seedArtistId=${seedArtistId}&limit=${limit}`);
};

ApiClient.prototype.getSimilarAlbums = async function (this: ApiClient, seedAlbumId: string, limit = 20) {
    return this.request(`/recommendations/albums?seedAlbumId=${seedAlbumId}&limit=${limit}`);
};

ApiClient.prototype.getSimilarTracks = async function (this: ApiClient, seedTrackId: string, limit = 20) {
    return this.request(`/recommendations/tracks?seedTrackId=${seedTrackId}&limit=${limit}`);
};

ApiClient.prototype.getPopularArtists = async function (this: ApiClient, limit = 20) {
    return this.request(`/discover/popular-artists?limit=${limit}`);
};
