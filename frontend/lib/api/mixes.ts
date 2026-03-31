import { ApiClient, ApiData, MoodPreset, MoodMixParams, MoodType, MoodBucketPreset, MoodBucketMix, SavedMoodMixResponse } from "./client";

declare module "./client" {
    interface ApiClient {
        getMixes(): Promise<ApiData[]>;
        getMix(id: string): Promise<ApiData>;
        getMixCoverUrl(mixId: string, size?: number): string;
        refreshMixes(): Promise<{ message: string; mixes: ApiData[] }>;
        saveMixAsPlaylist(mixId: string, customName?: string): Promise<{ id: string; name: string; trackCount: number }>;
        getMoodPresets(): Promise<MoodPreset[]>;
        generateMoodMix(params: MoodMixParams): Promise<ApiData>;
        getMoodBucketPresets(): Promise<MoodBucketPreset[]>;
        getMoodBucketMix(mood: MoodType): Promise<MoodBucketMix>;
        saveMoodBucketMix(mood: MoodType): Promise<SavedMoodMixResponse>;
        backfillMoodBuckets(): Promise<{ success: boolean; processed: number; assigned: number }>;
    }
}

ApiClient.prototype.getMixes = async function (this: ApiClient) {
    return this.request("/mixes");
};

ApiClient.prototype.getMix = async function (this: ApiClient, id: string) {
    return this.request(`/mixes/${id}`);
};

ApiClient.prototype.getMixCoverUrl = function (this: ApiClient, mixId: string, size = 300): string {
    const baseUrl = this.getBaseUrl();
    const token = this.getCurrentToken();
    const params = new URLSearchParams();
    params.append("size", size.toString());
    if (token) params.append("token", token);
    return `${baseUrl}/api/mixes/${encodeURIComponent(mixId)}/cover?${params.toString()}`;
};

ApiClient.prototype.refreshMixes = async function (this: ApiClient) {
    return this.request("/mixes/refresh", { method: "POST" });
};

ApiClient.prototype.saveMixAsPlaylist = async function (this: ApiClient, mixId: string, customName?: string) {
    return this.request(`/mixes/${mixId}/save`, {
        method: "POST",
        body: customName ? JSON.stringify({ name: customName }) : undefined,
    });
};

ApiClient.prototype.getMoodPresets = async function (this: ApiClient) {
    return this.request("/mixes/mood/presets");
};

ApiClient.prototype.generateMoodMix = async function (this: ApiClient, params: MoodMixParams) {
    return this.request("/mixes/mood", {
        method: "POST",
        body: JSON.stringify(params),
    });
};

ApiClient.prototype.getMoodBucketPresets = async function (this: ApiClient) {
    return this.request("/mixes/mood/buckets/presets");
};

ApiClient.prototype.getMoodBucketMix = async function (this: ApiClient, mood: MoodType) {
    return this.request(`/mixes/mood/buckets/${mood}`);
};

ApiClient.prototype.saveMoodBucketMix = async function (this: ApiClient, mood: MoodType) {
    return this.request(`/mixes/mood/buckets/${mood}/save`, { method: "POST" });
};

ApiClient.prototype.backfillMoodBuckets = async function (this: ApiClient) {
    return this.request("/mixes/mood/buckets/backfill", { method: "POST" });
};
