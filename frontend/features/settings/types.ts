/**
 * Settings Types
 * Centralized type definitions for the settings feature
 */

export type Tab = "user" | "account" | "system";

export interface UserSettings {
    playbackQuality: "original" | "high" | "medium" | "low";
    wifiOnly: boolean;
    offlineEnabled: boolean;
    maxCacheSizeMb: number;
}

export interface SystemSettings {
    // Lidarr
    lidarrEnabled: boolean;
    lidarrUrl: string;
    lidarrApiKey: string;
    // AI Services
    openaiEnabled: boolean;
    openaiApiKey: string;
    openaiModel: string;
    fanartEnabled: boolean;
    fanartApiKey: string;
    lastfmApiKey: string;
    // Audiobookshelf
    audiobookshelfEnabled: boolean;
    audiobookshelfUrl: string;
    audiobookshelfApiKey: string;
    // Jellyfin (Lidifin - music library and streaming)
    jellyfinEnabled?: boolean;
    jellyfinUrl?: string | null;
    jellyfinApiKey?: string | null;
    jellyfinApiKeyFromEnv?: boolean;
    jellyfinProxyStreams?: boolean;
    jellyfinUserId?: string | null; // Optional: provide so user-scoped API paths work with API key
    // AudioMuse-AI (instant playlist from mood/vibe)
    audiomuseEnabled?: boolean;
    audiomuseUrl?: string | null;
    audiomuseAiProvider?: string | null;
    audiomuseAiModel?: string | null;
    audiomuseApiKey?: string | null;
    audiomuseOllamaUrl?: string | null;
    // Soulseek (direct connection via slsk-client)
    soulseekUsername: string;
    soulseekPassword: string;
    // Spotify (for playlist import)
    spotifyClientId: string;
    spotifyClientSecret: string;
    // Storage
    musicPath: string;
    downloadPath: string;
    // Advanced
    transcodeCacheMaxGb: number;
    maxCacheSizeMb: number;
    autoSync: boolean;
    autoEnrichMetadata: boolean;
    audioAnalyzerWorkers: number;
    soulseekConcurrentDownloads: number;
    // Download Preferences
    downloadSource: "soulseek" | "lidarr";
    primaryFailureFallback: "none" | "lidarr" | "soulseek";
    // Secret presence flags (read-only, from GET /system-settings).
    // Secrets themselves are never returned by the API; these indicate
    // whether a value is already stored so the UI can show "saved" state
    // and enable connection tests without re-entering the secret.
    lidarrApiKeySet?: boolean;
    lidarrWebhookSecretSet?: boolean;
    openaiApiKeySet?: boolean;
    fanartApiKeySet?: boolean;
    lastfmApiKeySet?: boolean;
    audiobookshelfApiKeySet?: boolean;
    soulseekPasswordSet?: boolean;
    spotifyClientSecretSet?: boolean;
    audiomuseApiKeySet?: boolean;
    jellyfinApiKeySet?: boolean;
    jellyfinPasswordSet?: boolean;
}

export interface ApiKey {
    id: string;
    name: string;
    keyPreview?: string;
    createdAt: string;
    lastUsed?: string | null;
    lastUsedAt?: string | null;
}

export interface User {
    id: string;
    username: string;
    role: "user" | "admin";
    createdAt: string;
}

export interface ConfirmModalConfig {
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
}
