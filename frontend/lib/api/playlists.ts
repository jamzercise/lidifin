import { ApiClient, ApiData } from "./client";

declare module "./client" {
    interface ApiClient {
        getPlaylists(): Promise<ApiData[]>;
        getPlaylist(id: string): Promise<ApiData>;
        createPlaylist(name: string, isPublic?: boolean): Promise<ApiData>;
        updatePlaylist(id: string, data: { name?: string; isPublic?: boolean }): Promise<ApiData>;
        deletePlaylist(id: string): Promise<void>;
        addTrackToPlaylist(playlistId: string, trackId: string): Promise<ApiData>;
        removeTrackFromPlaylist(playlistId: string, trackId: string): Promise<void>;
        hidePlaylist(playlistId: string): Promise<{ message: string; isHidden: boolean }>;
        unhidePlaylist(playlistId: string): Promise<{ message: string; isHidden: boolean }>;
        retryPendingTrack(playlistId: string, pendingTrackId: string): Promise<{ success: boolean; message: string; error?: string; filePath?: string }>;
        removePendingTrack(playlistId: string, pendingTrackId: string): Promise<{ message: string }>;
        getFreshPreviewUrl(playlistId: string, pendingTrackId: string): Promise<{ previewUrl: string }>;
        getPlaylistCoverUrl(playlistId: string, size?: number): string;
    }
}

ApiClient.prototype.getPlaylists = async function (this: ApiClient) {
    return this.request("/playlists");
};

ApiClient.prototype.getPlaylist = async function (this: ApiClient, id: string) {
    return this.request(`/playlists/${id}`);
};

ApiClient.prototype.createPlaylist = async function (this: ApiClient, name: string, isPublic = false) {
    return this.request("/playlists", {
        method: "POST",
        body: JSON.stringify({ name, isPublic }),
    });
};

ApiClient.prototype.updatePlaylist = async function (this: ApiClient, id: string, data: { name?: string; isPublic?: boolean }) {
    return this.request(`/playlists/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
    });
};

ApiClient.prototype.deletePlaylist = async function (this: ApiClient, id: string) {
    return this.request(`/playlists/${id}`, { method: "DELETE" });
};

ApiClient.prototype.addTrackToPlaylist = async function (this: ApiClient, playlistId: string, trackId: string) {
    return this.request(`/playlists/${playlistId}/items`, {
        method: "POST",
        body: JSON.stringify({ trackId }),
    });
};

ApiClient.prototype.removeTrackFromPlaylist = async function (this: ApiClient, playlistId: string, trackId: string) {
    return this.request(`/playlists/${playlistId}/items/${trackId}`, { method: "DELETE" });
};

ApiClient.prototype.hidePlaylist = async function (this: ApiClient, playlistId: string) {
    return this.request(`/playlists/${playlistId}/hide`, { method: "POST" });
};

ApiClient.prototype.unhidePlaylist = async function (this: ApiClient, playlistId: string) {
    return this.request(`/playlists/${playlistId}/hide`, { method: "DELETE" });
};

ApiClient.prototype.retryPendingTrack = async function (this: ApiClient, playlistId: string, pendingTrackId: string) {
    return this.request(`/playlists/${playlistId}/pending/${pendingTrackId}/retry`, { method: "POST" });
};

ApiClient.prototype.removePendingTrack = async function (this: ApiClient, playlistId: string, pendingTrackId: string) {
    return this.request(`/playlists/${playlistId}/pending/${pendingTrackId}`, { method: "DELETE" });
};

ApiClient.prototype.getFreshPreviewUrl = async function (this: ApiClient, playlistId: string, pendingTrackId: string) {
    return this.request(`/playlists/${playlistId}/pending/${pendingTrackId}/preview`);
};

ApiClient.prototype.getPlaylistCoverUrl = function (this: ApiClient, playlistId: string, size = 300): string {
    const baseUrl = this.getBaseUrl();
    const token = this.getCurrentToken();
    const params = new URLSearchParams();
    params.append("size", size.toString());
    if (token) params.append("token", token);
    return `${baseUrl}/api/playlists/${encodeURIComponent(playlistId)}/cover?${params.toString()}`;
};
