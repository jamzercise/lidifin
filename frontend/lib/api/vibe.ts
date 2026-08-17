import { ApiClient } from "./client";

declare module "./client" {
    interface ApiClient {
        getVibeSimilarTracks(trackId: string, limit?: number): Promise<{
            sourceTrackId: string;
            tracks: Array<{
                id: string;
                title: string;
                duration: number;
                trackNo: number;
                distance: number;
                album: { id: string; title: string; coverUrl: string | null };
                artist: { id: string; name: string };
            }>;
        }>;
        vibeSearch(query: string, limit?: number): Promise<{
            query: string;
            tracks: Array<{
                id: string;
                title: string;
                duration: number;
                trackNo: number;
                distance: number;
                similarity: number;
                album: { id: string; title: string; coverUrl: string | null };
                artist: { id: string; name: string };
            }>;
            minSimilarity: number;
            totalAboveThreshold: number;
        }>;
        warmupVibeSearch(): Promise<void>;
        getVibeStatus(): Promise<{
            totalTracks: number;
            embeddedTracks: number;
            progress: number;
            isComplete: boolean;
            available?: boolean;
            message?: string;
        }>;
    }
}

ApiClient.prototype.getVibeSimilarTracks = async function (this: ApiClient, trackId: string, limit = 20) {
    return this.request(`/vibe/similar/${trackId}?limit=${limit}`);
};

ApiClient.prototype.vibeSearch = async function (this: ApiClient, query: string, limit = 20) {
    return this.request("/vibe/search", {
        method: "POST",
        body: JSON.stringify({ query, limit }),
    });
};

ApiClient.prototype.getVibeStatus = async function (this: ApiClient) {
    return this.request("/vibe/status");
};

/**
 * AudioMuse unloads its text model after ~10 minutes idle, which makes the first
 * search of a session slow. Called when the vibe page opens so the model is
 * loading while the user is still typing.
 */
ApiClient.prototype.warmupVibeSearch = async function (this: ApiClient) {
    await this.request("/vibe/warmup", { method: "POST" });
};
