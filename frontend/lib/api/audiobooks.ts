import { ApiClient, ApiData } from "./client";

declare module "./client" {
    interface ApiClient {
        getAudiobooks(): Promise<ApiData[]>;
        getAudiobook(id: string): Promise<ApiData>;
        getAudiobookSeries(seriesName: string): Promise<ApiData[]>;
        getAudiobookStreamUrl(id: string): string;
        getAudiobookStreamUrlForCast(id: string): string;
        updateAudiobookProgress(id: string, currentTime: number, duration: number, isFinished?: boolean): Promise<ApiData>;
        deleteAudiobookProgress(id: string): Promise<ApiData>;
        getContinueListening(): Promise<ApiData[]>;
        searchAudiobooks(query: string): Promise<ApiData[]>;
        syncAudiobooks(): Promise<{ success: boolean; result?: { synced: number; failed: number; skipped: number; errors: string[] } }>;
    }
}

ApiClient.prototype.getAudiobooks = async function (this: ApiClient) {
    return this.request("/audiobooks");
};

ApiClient.prototype.getAudiobook = async function (this: ApiClient, id: string) {
    return this.request(`/audiobooks/${id}`);
};

ApiClient.prototype.getAudiobookSeries = async function (this: ApiClient, seriesName: string) {
    return this.request(`/audiobooks/series/${encodeURIComponent(seriesName)}`);
};

ApiClient.prototype.getAudiobookStreamUrl = function (this: ApiClient, id: string): string {
    const baseUrl = `${this.getBaseUrl()}/api/audiobooks/${id}/stream`;
    const token = this.getCurrentToken();
    if (token) {
        return `${baseUrl}?token=${encodeURIComponent(token)}`;
    }
    return baseUrl;
};

ApiClient.prototype.getAudiobookStreamUrlForCast = function (this: ApiClient, id: string): string {
    const base = this.getBaseUrlForCast();
    const path = `/api/audiobooks/${id}/stream`;
    const token = this.getCurrentToken();
    const url = base ? `${base}${path}` : `${path}`;
    if (token) {
        return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
    }
    return url;
};

ApiClient.prototype.updateAudiobookProgress = async function (this: ApiClient, id: string, currentTime: number, duration: number, isFinished: boolean = false) {
    return this.request(`/audiobooks/${id}/progress`, {
        method: "POST",
        body: JSON.stringify({ currentTime, duration, isFinished }),
    });
};

ApiClient.prototype.deleteAudiobookProgress = async function (this: ApiClient, id: string) {
    return this.request(`/audiobooks/${id}/progress`, { method: "DELETE" });
};

ApiClient.prototype.getContinueListening = async function (this: ApiClient) {
    return this.request("/audiobooks/continue-listening");
};

ApiClient.prototype.searchAudiobooks = async function (this: ApiClient, query: string) {
    return this.request(`/audiobooks/search?q=${encodeURIComponent(query)}`);
};

ApiClient.prototype.syncAudiobooks = async function (this: ApiClient) {
    return this.request("/audiobooks/sync", { method: "POST" });
};
