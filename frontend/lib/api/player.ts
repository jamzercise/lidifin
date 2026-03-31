import { ApiClient, ApiData } from "./client";

declare module "./client" {
    interface ApiClient {
        trackPlayback(trackId: string, progress?: number): Promise<void>;
        logPlay(trackId: string): Promise<ApiData>;
        getRecentPlays(limit?: number): Promise<ApiData[]>;
        getPlaybackState(): Promise<ApiData>;
        savePlaybackState(state: {
            playbackType: string;
            trackId?: string;
            audiobookId?: string;
            podcastId?: string;
            queue?: ApiData[];
            currentIndex?: number;
            isShuffle?: boolean;
        }): Promise<ApiData>;
        clearPlaybackState(): Promise<void>;
    }
}

ApiClient.prototype.trackPlayback = async function (this: ApiClient, trackId: string, progress?: number) {
    return this.request("/playback/track", {
        method: "POST",
        body: JSON.stringify({ trackId, progress }),
    });
};

ApiClient.prototype.logPlay = async function (this: ApiClient, trackId: string) {
    return this.request("/plays", {
        method: "POST",
        body: JSON.stringify({ trackId }),
    });
};

ApiClient.prototype.getRecentPlays = async function (this: ApiClient, limit = 50) {
    return this.request(`/plays?limit=${limit}`);
};

ApiClient.prototype.getPlaybackState = async function (this: ApiClient) {
    return this.request("/playback-state");
};

ApiClient.prototype.savePlaybackState = async function (this: ApiClient, state: {
    playbackType: string;
    trackId?: string;
    audiobookId?: string;
    podcastId?: string;
    queue?: ApiData[];
    currentIndex?: number;
    isShuffle?: boolean;
}) {
    return this.request("/playback-state", {
        method: "POST",
        body: JSON.stringify(state),
    });
};

ApiClient.prototype.clearPlaybackState = async function (this: ApiClient) {
    return this.request("/playback-state", { method: "DELETE" });
};
