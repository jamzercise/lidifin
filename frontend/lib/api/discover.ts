import { ApiClient, ApiData } from "./client";

declare module "./client" {
    interface ApiClient {
        generateDiscoverWeekly(): Promise<{ message: string; jobId: string }>;
        getDiscoverGenerationStatus(jobId: string): Promise<{
            status: string;
            progress: number;
            result?: { success: boolean; playlistName: string; songCount: number; error?: string };
        }>;
        getCurrentDiscoverWeekly(): Promise<{ weekStart: string; weekEnd: string; tracks: ApiData[]; unavailable: ApiData[]; totalCount: number; unavailableCount: number }>;
        getDiscoverBatchStatus(): Promise<{ active: boolean; status: "downloading" | "scanning" | null; batchId?: string; progress?: number; completed?: number; failed?: number; total?: number }>;
        likeDiscoverAlbum(albumId: string): Promise<{ success: boolean }>;
        unlikeDiscoverAlbum(albumId: string): Promise<{ success: boolean }>;
        getDiscoverConfig(): Promise<{ id: string; userId: string; playlistSize: number; enabled: boolean; lastGeneratedAt: string | null }>;
        updateDiscoverConfig(config: { playlistSize?: number; enabled?: boolean }): Promise<{ id: string; userId: string; playlistSize: number; enabled: boolean; lastGeneratedAt: string | null }>;
        clearDiscoverPlaylist(): Promise<{ success: boolean; message: string; likedMoved: number; activeDeleted: number }>;
        getDiscoverExclusions(): Promise<{ exclusions: Array<{ id: string; albumMbid: string; artistName: string; albumTitle: string; lastSuggestedAt: string; expiresAt: string }>; count: number }>;
        clearDiscoverExclusions(): Promise<{ success: boolean; message: string; clearedCount: number }>;
        removeDiscoverExclusion(id: string): Promise<{ success: boolean; message: string }>;
        getArtistDiscovery(nameOrMbid: string): Promise<ApiData>;
        getAlbumDiscovery(rgMbid: string): Promise<ApiData>;
        getTrackPreview(artistName: string, trackTitle: string): Promise<{ previewUrl: string }>;
    }
}

ApiClient.prototype.generateDiscoverWeekly = async function (this: ApiClient) {
    return this.request("/discover/generate", { method: "POST" });
};

ApiClient.prototype.getDiscoverGenerationStatus = async function (this: ApiClient, jobId: string) {
    return this.request(`/discover/generate/status/${jobId}`);
};

ApiClient.prototype.getCurrentDiscoverWeekly = async function (this: ApiClient) {
    return this.request("/discover/current");
};

ApiClient.prototype.getDiscoverBatchStatus = async function (this: ApiClient) {
    return this.request("/discover/batch-status");
};

ApiClient.prototype.likeDiscoverAlbum = async function (this: ApiClient, albumId: string) {
    return this.request("/discover/like", {
        method: "POST",
        body: JSON.stringify({ albumId }),
    });
};

ApiClient.prototype.unlikeDiscoverAlbum = async function (this: ApiClient, albumId: string) {
    return this.request("/discover/unlike", {
        method: "DELETE",
        body: JSON.stringify({ albumId }),
    });
};

ApiClient.prototype.getDiscoverConfig = async function (this: ApiClient) {
    return this.request("/discover/config");
};

ApiClient.prototype.updateDiscoverConfig = async function (this: ApiClient, config: { playlistSize?: number; enabled?: boolean }) {
    return this.request("/discover/config", {
        method: "PATCH",
        body: JSON.stringify(config),
    });
};

ApiClient.prototype.clearDiscoverPlaylist = async function (this: ApiClient) {
    return this.request("/discover/clear", { method: "DELETE" });
};

ApiClient.prototype.getDiscoverExclusions = async function (this: ApiClient) {
    return this.request("/discover/exclusions");
};

ApiClient.prototype.clearDiscoverExclusions = async function (this: ApiClient) {
    return this.request("/discover/exclusions", { method: "DELETE" });
};

ApiClient.prototype.removeDiscoverExclusion = async function (this: ApiClient, id: string) {
    return this.request(`/discover/exclusions/${id}`, { method: "DELETE" });
};

ApiClient.prototype.getArtistDiscovery = async function (this: ApiClient, nameOrMbid: string) {
    return this.request(`/artists/discover/${encodeURIComponent(nameOrMbid)}`);
};

ApiClient.prototype.getAlbumDiscovery = async function (this: ApiClient, rgMbid: string) {
    return this.request(`/artists/album/${encodeURIComponent(rgMbid)}`);
};

ApiClient.prototype.getTrackPreview = async function (this: ApiClient, artistName: string, trackTitle: string) {
    return this.request(`/artists/preview/${encodeURIComponent(artistName)}/${encodeURIComponent(trackTitle)}`);
};
