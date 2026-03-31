import { ApiClient, ApiData, ServiceTestResult } from "./client";

declare module "./client" {
    interface ApiClient {
        getSettings(): Promise<ApiData>;
        updateSettings(settings: ApiData): Promise<ApiData>;
        getFeatures(): Promise<{ musicCNN: boolean; vibeEmbeddings: boolean }>;
        getSystemSettings(): Promise<ApiData>;
        updateSystemSettings(settings: ApiData): Promise<ApiData>;
        clearAllCaches(): Promise<ApiData>;
        cleanupStaleJobs(): Promise<{
            success: boolean;
            cleaned: {
                discoveryBatches: { cleaned: number; ids: string[] };
                downloadJobs: { cleaned: number; ids: string[] };
                spotifyImportJobs: { cleaned: number; ids: string[] };
                bullQueues: { cleaned: number; queues: string[] };
            };
            totalCleaned: number;
        }>;
        testLidarr(url: string, apiKey: string): Promise<ServiceTestResult>;
        testNzbget(url: string, username: string, password: string): Promise<ServiceTestResult>;
        testQbittorrent(url: string, username: string, password: string): Promise<ServiceTestResult>;
        testLastfm(apiKey: string): Promise<ServiceTestResult>;
        testOpenai(apiKey: string, model: string): Promise<ServiceTestResult>;
        testFanart(apiKey: string): Promise<ServiceTestResult>;
        testAudiobookshelf(url: string, apiKey: string): Promise<ServiceTestResult>;
        testJellyfin(url?: string, apiKey?: string): Promise<ServiceTestResult>;
        testSoulseek(username: string, password: string): Promise<ServiceTestResult>;
        testSpotify(clientId: string, clientSecret: string): Promise<ServiceTestResult>;
        testListenNotes(apiKey: string): Promise<ServiceTestResult>;
        testDeezer(apiKey?: string): Promise<ServiceTestResult>;
        downloadAlbum(artistName: string, albumTitle: string, rgMbid?: string, downloadType?: "library" | "discovery"): Promise<ApiData>;
        downloadArtist(artistName: string, mbid: string, downloadType?: "library" | "discovery"): Promise<ApiData>;
        getDownloadStatus(id: string): Promise<ApiData>;
        getDownloads(limit?: number, includeDiscovery?: boolean): Promise<ApiData[]>;
        deleteDownload(id: string): Promise<{ success: boolean }>;
        getSlskdStatus(): Promise<{ enabled: boolean; connected: boolean; username?: string; message?: string }>;
        searchSoulseek(query: string): Promise<{ searchId: string; message: string }>;
        getSoulseekResults(searchId: string): Promise<{ results: ApiData[]; count: number }>;
        downloadFromSoulseek(username: string, filepath: string, filename?: string, size?: number, artist?: string, album?: string, title?: string): Promise<{ success: boolean; message: string; filename: string }>;
        downloadTrackByArtistTitle(artist: string, title: string, album?: string): Promise<{ success: boolean; filePath?: string; error?: string }>;
        getSlskdDownloads(): Promise<{ downloads: ApiData[]; count: number }>;
        getEnrichmentSettings(): Promise<ApiData>;
        updateEnrichmentSettings(settings: ApiData): Promise<ApiData>;
        enrichArtist(artistId: string): Promise<{ success: boolean; confidence: number; data: ApiData }>;
        enrichAlbum(albumId: string): Promise<{ success: boolean; confidence: number; data: ApiData }>;
        startLibraryEnrichment(): Promise<{ success: boolean; message: string }>;
        syncLibraryEnrichment(): Promise<{ message: string; description: string; result: { artists: number; tracks: number; audioQueued: number } }>;
        getEnrichmentProgress(): Promise<{
            artists: { total: number; completed: number; pending: number; failed: number; progress: number };
            trackTags: { total: number; enriched: number; pending: number; progress: number };
            audioAnalysis: { total: number; completed: number; pending: number; processing: number; failed: number; progress: number; isBackground: boolean };
            clapEmbeddings: { total: number; completed: number; pending: number; processing: number; failed: number; progress: number; isBackground: boolean };
            coreComplete: boolean;
            isFullyComplete: boolean;
        }>;
        triggerFullEnrichment(): Promise<{ message: string; description: string }>;
        resetArtistsOnly(): Promise<{ message: string; description: string; count: number }>;
        resetMoodTagsOnly(): Promise<{ message: string; description: string; count: number }>;
        resetAudioAnalysisOnly(): Promise<{ message: string; description: string; count: number }>;
        retryFailedAnalysis(): Promise<{ message: string; reset: number }>;
        updateArtistMetadata(artistId: string, data: { name?: string; bio?: string; genres?: string[]; mbid?: string; heroUrl?: string }): Promise<ApiData>;
        updateAlbumMetadata(albumId: string, data: { title?: string; year?: number; genres?: string[]; rgMbid?: string; coverUrl?: string }): Promise<ApiData>;
        updateTrackMetadata(trackId: string, data: ApiData): Promise<ApiData>;
        resetArtistMetadata(artistId: string): Promise<{ message: string; artist: ApiData }>;
        resetAlbumMetadata(albumId: string): Promise<{ message: string; album: ApiData }>;
        resetTrackMetadata(trackId: string): Promise<{ message: string; track: ApiData }>;
        createApiKey(deviceName: string): Promise<{ apiKey: string; name: string; createdAt: string; message: string }>;
        listApiKeys(): Promise<{ apiKeys: Array<{ id: string; name: string; createdAt: string; lastUsed: string | null }> }>;
        revokeApiKey(id: string): Promise<{ message: string }>;
    }
}

// Settings
ApiClient.prototype.getSettings = async function (this: ApiClient) {
    return this.request("/settings");
};

ApiClient.prototype.updateSettings = async function (this: ApiClient, settings: ApiData) {
    return this.request("/settings", {
        method: "POST",
        body: JSON.stringify(settings),
    });
};

// System Features
ApiClient.prototype.getFeatures = async function (this: ApiClient) {
    return this.request("/system/features");
};

// System Settings
ApiClient.prototype.getSystemSettings = async function (this: ApiClient) {
    return this.request("/system-settings");
};

ApiClient.prototype.updateSystemSettings = async function (this: ApiClient, settings: ApiData) {
    return this.request("/system-settings", {
        method: "POST",
        body: JSON.stringify(settings),
    });
};

ApiClient.prototype.clearAllCaches = async function (this: ApiClient) {
    return this.request("/system-settings/clear-caches", { method: "POST" });
};

ApiClient.prototype.cleanupStaleJobs = async function (this: ApiClient) {
    return this.request("/settings/cleanup-stale-jobs", { method: "POST" });
};

// Service connection tests
ApiClient.prototype.testLidarr = async function (this: ApiClient, url: string, apiKey: string) {
    return this.request("/system-settings/test-lidarr", {
        method: "POST",
        body: JSON.stringify({ url, apiKey }),
    });
};

ApiClient.prototype.testNzbget = async function (this: ApiClient, url: string, username: string, password: string) {
    return this.request("/system-settings/test-nzbget", {
        method: "POST",
        body: JSON.stringify({ url, username, password }),
    });
};

ApiClient.prototype.testQbittorrent = async function (this: ApiClient, url: string, username: string, password: string) {
    return this.request("/system-settings/test-qbittorrent", {
        method: "POST",
        body: JSON.stringify({ url, username, password }),
    });
};

ApiClient.prototype.testLastfm = async function (this: ApiClient, apiKey: string) {
    return this.request("/system-settings/test-lastfm", {
        method: "POST",
        body: JSON.stringify({ lastfmApiKey: apiKey }),
    });
};

ApiClient.prototype.testOpenai = async function (this: ApiClient, apiKey: string, model: string) {
    return this.request("/system-settings/test-openai", {
        method: "POST",
        body: JSON.stringify({ apiKey, model }),
    });
};

ApiClient.prototype.testFanart = async function (this: ApiClient, apiKey: string) {
    return this.request("/system-settings/test-fanart", {
        method: "POST",
        body: JSON.stringify({ fanartApiKey: apiKey }),
    });
};

ApiClient.prototype.testAudiobookshelf = async function (this: ApiClient, url: string, apiKey: string) {
    return this.request("/system-settings/test-audiobookshelf", {
        method: "POST",
        body: JSON.stringify({ url, apiKey }),
    });
};

ApiClient.prototype.testJellyfin = async function (this: ApiClient, url?: string, apiKey?: string) {
    return this.request("/system-settings/test-jellyfin", {
        method: "POST",
        body: JSON.stringify({ url, apiKey }),
    });
};

ApiClient.prototype.testSoulseek = async function (this: ApiClient, username: string, password: string) {
    return this.request("/system-settings/test-soulseek", {
        method: "POST",
        body: JSON.stringify({ username, password }),
    });
};

ApiClient.prototype.testSpotify = async function (this: ApiClient, clientId: string, clientSecret: string) {
    return this.request("/system-settings/test-spotify", {
        method: "POST",
        body: JSON.stringify({ clientId, clientSecret }),
    });
};

ApiClient.prototype.testListenNotes = async function (this: ApiClient, apiKey: string) {
    return this.request("/system-settings/test-listennotes", {
        method: "POST",
        body: JSON.stringify({ apiKey }),
    });
};

ApiClient.prototype.testDeezer = async function (this: ApiClient, apiKey?: string) {
    return this.request("/system-settings/test-deezer", {
        method: "POST",
        body: JSON.stringify({ apiKey }),
    });
};

// Downloads (Lidarr)
ApiClient.prototype.downloadAlbum = async function (this: ApiClient, artistName: string, albumTitle: string, rgMbid?: string, downloadType: "library" | "discovery" = "library") {
    return this.request("/downloads", {
        method: "POST",
        body: JSON.stringify({
            type: "album",
            subject: `${artistName} - ${albumTitle}`,
            mbid: rgMbid,
            artistName,
            albumTitle,
            downloadType,
        }),
    });
};

ApiClient.prototype.downloadArtist = async function (this: ApiClient, artistName: string, mbid: string, downloadType: "library" | "discovery" = "library") {
    return this.request("/downloads", {
        method: "POST",
        body: JSON.stringify({
            type: "artist",
            subject: artistName,
            mbid,
            downloadType,
        }),
    });
};

ApiClient.prototype.getDownloadStatus = async function (this: ApiClient, id: string) {
    return this.request(`/downloads/${id}`);
};

ApiClient.prototype.getDownloads = async function (this: ApiClient, limit?: number, includeDiscovery: boolean = false) {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    params.set("includeDiscovery", String(includeDiscovery));
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request(`/downloads${query}`);
};

ApiClient.prototype.deleteDownload = async function (this: ApiClient, id: string) {
    return this.request(`/downloads/${id}`, { method: "DELETE" });
};

// Soulseek
ApiClient.prototype.getSlskdStatus = async function (this: ApiClient) {
    return this.request("/soulseek/status");
};

ApiClient.prototype.searchSoulseek = async function (this: ApiClient, query: string) {
    return this.request("/soulseek/search", {
        method: "POST",
        body: JSON.stringify({ query }),
    });
};

ApiClient.prototype.getSoulseekResults = async function (this: ApiClient, searchId: string) {
    return this.request(`/soulseek/search/${searchId}`);
};

ApiClient.prototype.downloadFromSoulseek = async function (this: ApiClient, username: string, filepath: string, filename?: string, size?: number, artist?: string, album?: string, title?: string) {
    return this.request("/soulseek/download", {
        method: "POST",
        body: JSON.stringify({ username, filepath, filename, size, artist, album, title }),
    });
};

ApiClient.prototype.downloadTrackByArtistTitle = async function (this: ApiClient, artist: string, title: string, album?: string) {
    return this.request("/soulseek/download", {
        method: "POST",
        body: JSON.stringify({
            artist,
            title,
            album: album || "Unknown Album",
        }),
    });
};

ApiClient.prototype.getSlskdDownloads = async function (this: ApiClient) {
    return this.request("/soulseek/downloads");
};

// Enrichment
ApiClient.prototype.getEnrichmentSettings = async function (this: ApiClient) {
    return this.request("/enrichment/settings");
};

ApiClient.prototype.updateEnrichmentSettings = async function (this: ApiClient, settings: ApiData) {
    return this.request("/enrichment/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
    });
};

ApiClient.prototype.enrichArtist = async function (this: ApiClient, artistId: string) {
    return this.request(`/enrichment/artist/${artistId}`, { method: "POST" });
};

ApiClient.prototype.enrichAlbum = async function (this: ApiClient, albumId: string) {
    return this.request(`/enrichment/album/${albumId}`, { method: "POST" });
};

ApiClient.prototype.startLibraryEnrichment = async function (this: ApiClient) {
    return this.request("/enrichment/start", { method: "POST" });
};

ApiClient.prototype.syncLibraryEnrichment = async function (this: ApiClient) {
    return this.request("/enrichment/sync", { method: "POST" });
};

ApiClient.prototype.getEnrichmentProgress = async function (this: ApiClient) {
    return this.request("/enrichment/progress");
};

ApiClient.prototype.triggerFullEnrichment = async function (this: ApiClient) {
    return this.request("/enrichment/full", { method: "POST" });
};

ApiClient.prototype.resetArtistsOnly = async function (this: ApiClient) {
    return this.request("/enrichment/reset-artists", { method: "POST" });
};

ApiClient.prototype.resetMoodTagsOnly = async function (this: ApiClient) {
    return this.request("/enrichment/reset-mood-tags", { method: "POST" });
};

ApiClient.prototype.resetAudioAnalysisOnly = async function (this: ApiClient) {
    return this.request("/enrichment/reset-audio-analysis", { method: "POST" });
};

ApiClient.prototype.retryFailedAnalysis = async function (this: ApiClient) {
    return this.request("/analysis/retry-failed", { method: "POST" });
};

ApiClient.prototype.updateArtistMetadata = async function (this: ApiClient, artistId: string, data: { name?: string; bio?: string; genres?: string[]; mbid?: string; heroUrl?: string }) {
    return this.request(`/enrichment/artists/${artistId}/metadata`, {
        method: "PUT",
        body: JSON.stringify(data),
    });
};

ApiClient.prototype.updateAlbumMetadata = async function (this: ApiClient, albumId: string, data: { title?: string; year?: number; genres?: string[]; rgMbid?: string; coverUrl?: string }) {
    return this.request(`/enrichment/albums/${albumId}/metadata`, {
        method: "PUT",
        body: JSON.stringify(data),
    });
};

ApiClient.prototype.updateTrackMetadata = async function (this: ApiClient, trackId: string, data: ApiData) {
    return this.request(`/library/tracks/${trackId}/metadata`, {
        method: "PUT",
        body: JSON.stringify(data),
    });
};

ApiClient.prototype.resetArtistMetadata = async function (this: ApiClient, artistId: string) {
    return this.request(`/enrichment/artists/${artistId}/reset`, { method: "POST" });
};

ApiClient.prototype.resetAlbumMetadata = async function (this: ApiClient, albumId: string) {
    return this.request(`/enrichment/albums/${albumId}/reset`, { method: "POST" });
};

ApiClient.prototype.resetTrackMetadata = async function (this: ApiClient, trackId: string) {
    return this.request(`/enrichment/tracks/${trackId}/reset`, { method: "POST" });
};

// API Keys
ApiClient.prototype.createApiKey = async function (this: ApiClient, deviceName: string) {
    return this.post("/api-keys", { deviceName });
};

ApiClient.prototype.listApiKeys = async function (this: ApiClient) {
    return this.get("/api-keys");
};

ApiClient.prototype.revokeApiKey = async function (this: ApiClient, id: string) {
    return this.delete(`/api-keys/${id}`);
};
