import { ApiClient, ApiData } from "./client";

declare module "./client" {
    interface ApiClient {
        getPodcasts(): Promise<ApiData[]>;
        getNewEpisodes(limit?: number): Promise<ApiData[]>;
        getPodcastContinueListening(limit?: number): Promise<ApiData[]>;
        getPodcast(id: string): Promise<ApiData>;
        previewPodcast(itunesId: string): Promise<ApiData>;
        getPodcastEpisode(podcastId: string, episodeId: string): Promise<ApiData>;
        getPodcastEpisodeStreamUrl(podcastId: string, episodeId: string): string;
        getPodcastEpisodeStreamUrlForCast(podcastId: string, episodeId: string): string;
        getPodcastEpisodeCacheStatus(podcastId: string, episodeId: string): Promise<{ cached: boolean; downloading: boolean; downloadProgress: number | null }>;
        updatePodcastEpisodeProgress(podcastId: string, episodeId: string, currentTime: number, duration: number, isFinished?: boolean): Promise<ApiData>;
        updatePodcastProgress(podcastId: string, episodeId: string, currentTime: number, duration: number, isFinished?: boolean): Promise<ApiData>;
        deletePodcastEpisodeProgress(podcastId: string, episodeId: string): Promise<ApiData>;
        getSimilarPodcasts(podcastId: string): Promise<ApiData[]>;
        getTopPodcasts(limit?: number, genreId?: number): Promise<ApiData[]>;
        getPodcastsByGenre(genreIds: number[]): Promise<ApiData>;
        getPodcastsByGenrePaginated(genreId: number, limit?: number, offset?: number): Promise<ApiData[]>;
        subscribePodcast(feedUrl: string, itunesId?: string): Promise<{ success: boolean; podcast?: ApiData }>;
        removePodcast(podcastId: string): Promise<{ success: boolean; message: string }>;
        getHomepageTopPodcasts(limit?: number): Promise<ApiData[]>;
    }
}

ApiClient.prototype.getPodcasts = async function (this: ApiClient) {
    return this.request("/podcasts");
};

ApiClient.prototype.getNewEpisodes = async function (this: ApiClient, limit = 20) {
    return this.request(`/podcasts/new-episodes?limit=${limit}`);
};

ApiClient.prototype.getPodcastContinueListening = async function (this: ApiClient, limit = 20) {
    return this.request(`/podcasts/continue-listening?limit=${limit}`);
};

ApiClient.prototype.getPodcast = async function (this: ApiClient, id: string) {
    return this.request(`/podcasts/${id}`, { silent404: true });
};

ApiClient.prototype.previewPodcast = async function (this: ApiClient, itunesId: string) {
    return this.request(`/podcasts/preview/${itunesId}`);
};

ApiClient.prototype.getPodcastEpisode = async function (this: ApiClient, podcastId: string, episodeId: string) {
    return this.request(`/podcasts/${podcastId}/episodes/${episodeId}`);
};

ApiClient.prototype.getPodcastEpisodeStreamUrl = function (this: ApiClient, podcastId: string, episodeId: string): string {
    const baseUrl = `${this.getBaseUrl()}/api/podcasts/${podcastId}/episodes/${episodeId}/stream`;
    const token = this.getCurrentToken();
    if (token) {
        return `${baseUrl}?token=${encodeURIComponent(token)}`;
    }
    return baseUrl;
};

ApiClient.prototype.getPodcastEpisodeStreamUrlForCast = function (this: ApiClient, podcastId: string, episodeId: string): string {
    const base = this.getBaseUrlForCast();
    const path = `/api/podcasts/${podcastId}/episodes/${episodeId}/stream`;
    const token = this.getCurrentToken();
    const url = base ? `${base}${path}` : `${path}`;
    if (token) {
        return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    }
    return url;
};

ApiClient.prototype.getPodcastEpisodeCacheStatus = async function (this: ApiClient, podcastId: string, episodeId: string) {
    return this.request(`/podcasts/${podcastId}/episodes/${episodeId}/cache-status`);
};

ApiClient.prototype.updatePodcastEpisodeProgress = async function (this: ApiClient, podcastId: string, episodeId: string, currentTime: number, duration: number, isFinished: boolean = false) {
    return this.request(`/podcasts/${podcastId}/episodes/${episodeId}/progress`, {
        method: "POST",
        body: JSON.stringify({ currentTime, duration, isFinished }),
    });
};

ApiClient.prototype.updatePodcastProgress = async function (this: ApiClient, podcastId: string, episodeId: string, currentTime: number, duration: number, isFinished: boolean = false) {
    return this.updatePodcastEpisodeProgress(podcastId, episodeId, currentTime, duration, isFinished);
};

ApiClient.prototype.deletePodcastEpisodeProgress = async function (this: ApiClient, podcastId: string, episodeId: string) {
    return this.request(`/podcasts/${podcastId}/episodes/${episodeId}/progress`, { method: "DELETE" });
};

ApiClient.prototype.getSimilarPodcasts = async function (this: ApiClient, podcastId: string) {
    return this.request(`/podcasts/${podcastId}/similar`);
};

ApiClient.prototype.getTopPodcasts = async function (this: ApiClient, limit = 20, genreId?: number) {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (genreId) params.append("genreId", genreId.toString());
    return this.request(`/podcasts/discover/top?${params.toString()}`);
};

ApiClient.prototype.getPodcastsByGenre = async function (this: ApiClient, genreIds: number[]) {
    return this.request(`/podcasts/discover/genres?genres=${genreIds.join(",")}`);
};

ApiClient.prototype.getPodcastsByGenrePaginated = async function (this: ApiClient, genreId: number, limit = 20, offset = 0) {
    return this.request(`/podcasts/discover/genre/${genreId}?limit=${limit}&offset=${offset}`);
};

ApiClient.prototype.subscribePodcast = async function (this: ApiClient, feedUrl: string, itunesId?: string) {
    return this.request("/podcasts/subscribe", {
        method: "POST",
        body: JSON.stringify({ feedUrl, itunesId }),
    });
};

ApiClient.prototype.removePodcast = async function (this: ApiClient, podcastId: string) {
    return this.request(`/podcasts/${podcastId}/unsubscribe`, { method: "DELETE" });
};

ApiClient.prototype.getHomepageTopPodcasts = async function (this: ApiClient, limit = 6) {
    return this.request(`/homepage/top-podcasts?limit=${limit}`);
};
