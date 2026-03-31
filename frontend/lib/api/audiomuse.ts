import { ApiClient, ApiData, MoodType } from "./client";

declare module "./client" {
    interface ApiClient {
        getAudioMuseStatus(): Promise<{ enabled: boolean; available: boolean; aiProvider?: string; message?: string }>;
        testAudioMuse(url: string): Promise<{ enabled: boolean; available: boolean; message?: string }>;
        getAudioMuseInstantPlaylist(params: { mood?: MoodType; userInput?: string }): Promise<{ tracks: ApiData[]; totalCount: number; message?: string }>;
        getAudioMuseSimilarTracks(trackId: string, n?: number): Promise<{ tracks: ApiData[]; totalCount: number }>;
        getAudioMuseSimilarArtists(artistIdOrName: string, n?: number): Promise<{ artists: { id: string | null; name: string; divergence: number }[] }>;
        getAudioMuseArtistTracks(artistIdOrName: string): Promise<{ tracks: ApiData[]; totalCount: number }>;
        getAudioMuseAlchemy(params: { items: { id: string; op: "ADD" | "SUBTRACT"; type?: "song" | "artist" }[]; n?: number }): Promise<{ tracks: ApiData[]; totalCount: number }>;
        saveAudioMusePlaylist(name: string, trackIds: string[]): Promise<{ success: boolean; playlistId?: string }>;
    }
}

ApiClient.prototype.getAudioMuseStatus = async function (this: ApiClient) {
    return this.request("/mixes/audiomuse/status");
};

ApiClient.prototype.testAudioMuse = async function (this: ApiClient, url: string) {
    return this.request("/mixes/audiomuse/test", {
        method: "POST",
        body: JSON.stringify({ url: url?.trim() || "" }),
    });
};

ApiClient.prototype.getAudioMuseInstantPlaylist = async function (this: ApiClient, params: { mood?: MoodType; userInput?: string }) {
    return this.request("/mixes/audiomuse/instant", {
        method: "POST",
        body: JSON.stringify(params),
    });
};

ApiClient.prototype.getAudioMuseSimilarTracks = async function (this: ApiClient, trackId: string, n = 20) {
    return this.request(`/mixes/audiomuse/similar-tracks?trackId=${encodeURIComponent(trackId)}&n=${n}`);
};

ApiClient.prototype.getAudioMuseSimilarArtists = async function (this: ApiClient, artistIdOrName: string, n = 10) {
    const param = artistIdOrName.startsWith("jellyfin:")
        ? `artistId=${encodeURIComponent(artistIdOrName)}`
        : `artist=${encodeURIComponent(artistIdOrName)}`;
    return this.request(`/mixes/audiomuse/similar-artists?${param}&n=${n}`);
};

ApiClient.prototype.getAudioMuseArtistTracks = async function (this: ApiClient, artistIdOrName: string) {
    const param = artistIdOrName.startsWith("jellyfin:")
        ? `artistId=${encodeURIComponent(artistIdOrName)}`
        : `artist=${encodeURIComponent(artistIdOrName)}`;
    return this.request(`/mixes/audiomuse/artist-tracks?${param}`);
};

ApiClient.prototype.getAudioMuseAlchemy = async function (this: ApiClient, params: { items: { id: string; op: "ADD" | "SUBTRACT"; type?: "song" | "artist" }[]; n?: number }) {
    return this.request("/mixes/audiomuse/alchemy", {
        method: "POST",
        body: JSON.stringify(params),
    });
};

ApiClient.prototype.saveAudioMusePlaylist = async function (this: ApiClient, name: string, trackIds: string[]) {
    return this.request("/mixes/audiomuse/save-playlist", {
        method: "POST",
        body: JSON.stringify({ name, trackIds }),
    });
};
