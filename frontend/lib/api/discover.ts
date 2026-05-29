import { ApiClient, ApiData } from "./client";
import type { BatchContext } from "@/features/discover/types";

declare module "./client" {
    interface ApiClient {
        generateDiscoverWeekly(): Promise<{ message: string; jobId: string }>;
        getDiscoverGenerationStatus(jobId: string): Promise<{
            status: string;
            progress: number;
            result?: { success: boolean; playlistName: string; songCount: number; error?: string };
        }>;
        getCurrentDiscoverWeekly(): Promise<{ weekStart: string; weekEnd: string; tracks: ApiData[]; unavailable: ApiData[]; totalCount: number; unavailableCount: number; batchContext?: BatchContext | null }>;
        getDiscoverBatchStatus(): Promise<{ active: boolean; status: "downloading" | "scanning" | null; batchId?: string; progress?: number; completed?: number; failed?: number; total?: number; albums?: Array<{ id?: string; artist: string; album: string; status: string; error: string | null }> }>;
        rebuildDiscoverWeekly(): Promise<{ message: string; batchId: string; completedJobs?: number }>;
        cancelDiscoverGeneration(): Promise<{ message: string; cancelledJobs: number }>;
        retryDiscoverAlbum(jobId: string): Promise<{ message: string }>;
        likeDiscoverAlbum(albumId: string): Promise<{ success: boolean }>;
        unlikeDiscoverAlbum(albumId: string): Promise<{ success: boolean }>;
        getDiscoverConfig(): Promise<{ id: string; userId: string; playlistSize: number; exclusionMonths: number; downloadRatio: number; enabled: boolean; lastGeneratedAt: string | null }>;
        updateDiscoverConfig(config: { playlistSize?: number; exclusionMonths?: number; downloadRatio?: number; enabled?: boolean }): Promise<{ id: string; userId: string; playlistSize: number; exclusionMonths: number; downloadRatio: number; enabled: boolean; lastGeneratedAt: string | null }>;
        clearDiscoverPlaylist(): Promise<{ success: boolean; message: string; likedMoved: number; activeDeleted: number }>;
        getDiscoverExclusions(): Promise<{ exclusions: Array<{ id: string; albumMbid: string; artistName: string; albumTitle: string; lastSuggestedAt: string; expiresAt: string }>; count: number }>;
        clearDiscoverExclusions(): Promise<{ success: boolean; message: string; clearedCount: number }>;
        removeDiscoverExclusion(id: string): Promise<{ success: boolean; message: string }>;
        getArtistDiscovery(nameOrMbid: string): Promise<ApiData>;
        getAlbumDiscovery(rgMbid: string): Promise<ApiData>;
        getTrackPreview(artistName: string, trackTitle: string): Promise<{ previewUrl: string }>;
        getSavedDiscoveryAlbums(params?: {
            limit?: number;
            offset?: number;
        }): Promise<{
            albums: Array<{
                id: string;
                userId: string;
                rgMbid: string;
                artistName: string;
                artistMbid: string | null;
                albumTitle: string;
                coverUrl: string | null;
                source: string | null;
                savedAt: string;
            }>;
            total: number;
            offset: number;
            limit: number;
        }>;
        saveDiscoveryAlbum(body: {
            rgMbid: string;
            artistName: string;
            albumTitle: string;
            artistMbid?: string | null;
            coverUrl?: string | null;
            source?: string | null;
        }): Promise<{ album: ApiData }>;
        unsaveDiscoveryAlbum(rgMbid: string): Promise<{ removed: boolean }>;
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

ApiClient.prototype.cancelDiscoverGeneration = async function (this: ApiClient) {
    return this.request("/discover/cancel", { method: "POST" });
};

ApiClient.prototype.retryDiscoverAlbum = async function (this: ApiClient, jobId: string) {
    return this.request("/discover/retry-album", {
        method: "POST",
        body: JSON.stringify({ jobId }),
    });
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

ApiClient.prototype.updateDiscoverConfig = async function (this: ApiClient, config: { playlistSize?: number; exclusionMonths?: number; downloadRatio?: number; enabled?: boolean }) {
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

ApiClient.prototype.rebuildDiscoverWeekly = async function (this: ApiClient) {
    return this.request("/discover/rebuild", { method: "POST" });
};

ApiClient.prototype.getTrackPreview = async function (this: ApiClient, artistName: string, trackTitle: string) {
    return this.request(`/artists/preview/${encodeURIComponent(artistName)}/${encodeURIComponent(trackTitle)}`);
};

ApiClient.prototype.getSavedDiscoveryAlbums = async function (this: ApiClient, params?: {
    limit?: number;
    offset?: number;
}) {
    const q = new URLSearchParams();
    if (params?.limit != null) q.set("limit", String(params.limit));
    if (params?.offset != null) q.set("offset", String(params.offset));
    const qs = q.toString();
    return this.request(`/discover/saved-albums${qs ? `?${qs}` : ""}`);
};

ApiClient.prototype.saveDiscoveryAlbum = async function (this: ApiClient, body: {
    rgMbid: string;
    artistName: string;
    albumTitle: string;
    artistMbid?: string | null;
    coverUrl?: string | null;
    source?: string | null;
}) {
    return this.request("/discover/saved-albums", {
        method: "POST",
        body: JSON.stringify(body),
    });
};

ApiClient.prototype.unsaveDiscoveryAlbum = async function (this: ApiClient, rgMbid: string) {
    return this.request(`/discover/saved-albums/${encodeURIComponent(rgMbid)}`, {
        method: "DELETE",
    });
};
