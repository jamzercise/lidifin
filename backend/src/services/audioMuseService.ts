/**
 * AudioMuse-AI integration service.
 * Calls AudioMuse-AI's chatPlaylist API for instant playlist generation from mood/vibe text.
 * Returns Jellyfin item IDs that can be resolved to tracks via resolveTrackReferences.
 */

import axios from "axios";
import { getSystemSettings } from "../utils/systemSettings";
import { logger } from "../utils/logger";

export interface AudioMuseConfig {
    enabled: boolean;
    url: string;
    aiProvider: string | null;
    apiKey: string | null;
    aiModel: string | null;
    ollamaUrl: string | null;
}

/** Mood → natural language prompt for AudioMuse-AI. Shorter prompts favor faster single-iteration responses. */
export const MOOD_TO_PROMPT: Record<string, string> = {
    happy: "happy upbeat",
    sad: "sad melancholic",
    chill: "chill relaxed calm",
    energetic: "energetic intense",
    party: "party danceable",
    focus: "instrumental focus",
    melancholy: "melancholic reflective",
    aggressive: "aggressive intense",
    acoustic: "acoustic unplugged",
};

export async function getAudioMuseConfig(): Promise<AudioMuseConfig | null> {
    const settings = await getSystemSettings(true);
    if (!settings?.audiomuseEnabled || !settings?.audiomuseUrl?.trim()) {
        return null;
    }
    const url = settings.audiomuseUrl.replace(/\/$/, "");
    const aiProvider = settings.audiomuseAiProvider?.trim() || null;
    const apiKey = settings.audiomuseApiKey?.trim() || null;
    const aiModel = settings.audiomuseAiModel?.trim() || null;
    const ollamaUrl = settings.audiomuseOllamaUrl?.trim() || null;

    return {
        enabled: true,
        url,
        aiProvider,
        apiKey,
        aiModel,
        ollamaUrl,
    };
}

export interface AudioMusePlaylistResult {
    itemIds: string[];
    error?: string;
}

/**
 * Generate an instant playlist from a text prompt using AudioMuse-AI
 * Returns Jellyfin item IDs (without jellyfin: prefix)
 */
export async function generateInstantPlaylist(
    userInput: string
): Promise<AudioMusePlaylistResult> {
    const config = await getAudioMuseConfig();
    if (!config) {
        return { itemIds: [], error: "AudioMuse-AI is not configured" };
    }

    const aiProvider = config.aiProvider || "OLLAMA";
    if (aiProvider === "NONE") {
        return {
            itemIds: [],
            error: "Please configure an AI provider in AudioMuse-AI settings (OLLAMA, GEMINI, OPENAI, or MISTRAL)",
        };
    }

    const body: Record<string, unknown> = {
        userInput: userInput.trim(),
        ai_provider: aiProvider,
    };

    // Include ai_model from settings. Skip config_defaults fetch to avoid extra latency;
    // AudioMuse uses its server default when ai_model is omitted.
    if (config.aiModel) body.ai_model = config.aiModel;

    if (aiProvider === "OPENAI" && config.apiKey) {
        body.openai_api_key = config.apiKey;
    }
    if (aiProvider === "GEMINI" && config.apiKey) {
        body.gemini_api_key = config.apiKey;
    }
    if (aiProvider === "MISTRAL" && config.apiKey) {
        body.mistral_api_key = config.apiKey;
    }
    if (aiProvider === "OLLAMA" && config.ollamaUrl) {
        body.ollama_server_url = config.ollamaUrl;
    }

    try {
        const res = await axios.post(
            `${config.url}/chat/api/chatPlaylist`,
            body,
            {
                timeout: 180000, // 3 min - MCP workflow can take multiple AI iterations; align with route timeout
                headers: { "Content-Type": "application/json" },
                validateStatus: () => true,
            }
        );

        if (res.status !== 200) {
            logger.warn("[AudioMuse] chatPlaylist failed:", res.status, res.data);
            return {
                itemIds: [],
                error: res.data?.error || `AudioMuse-AI returned ${res.status}`,
            };
        }

        const response = res.data?.response;
        const queryResults = response?.query_results;

        if (!Array.isArray(queryResults) || queryResults.length === 0) {
            const msg = response?.message || "No results from AudioMuse-AI";
            logger.info("[AudioMuse] No playlist results:", msg.slice(0, 200));
            return {
                itemIds: [],
                error: msg.includes("No AI provider")
                    ? "Please configure an AI provider in AudioMuse-AI settings"
                    : "No tracks found for this request",
            };
        }

        const itemIds = queryResults
            .map((s: { item_id?: string }) => s?.item_id)
            .filter((id: unknown): id is string => typeof id === "string");

        logger.info(`[AudioMuse] Generated playlist with ${itemIds.length} tracks`);
        return { itemIds };
    } catch (err: any) {
        logger.warn("[AudioMuse] chatPlaylist error:", err.message);
        const isTimeout = err.code === "ECONNABORTED" || err.message?.includes("timeout");
        const isNetwork =
            err.code === "ECONNREFUSED" ||
            err.code === "ENOTFOUND" ||
            err.code === "ENETUNREACH";
        return {
            itemIds: [],
            error: isTimeout
                ? "AudioMuse-AI request timed out"
                : isNetwork
                  ? "Cannot reach AudioMuse-AI. Is it running?"
                  : err.message || "AudioMuse-AI request failed",
        };
    }
}

/** Strip jellyfin: prefix for AudioMuse-AI (expects raw Jellyfin UUID) */
function toRawId(id: string): string {
    return id.startsWith("jellyfin:") ? id.slice(9) : id;
}

export interface SimilarTrackResult {
    itemId: string;
    title: string;
    author: string;
    album: string;
    distance: number;
}

/**
 * Get similar tracks for a given track (Playlist from Similar Song)
 */
export async function getSimilarTracks(
    trackId: string,
    n = 20
): Promise<{ tracks: SimilarTrackResult[]; error?: string }> {
    const config = await getAudioMuseConfig();
    if (!config) return { tracks: [], error: "AudioMuse-AI is not configured" };

    const rawId = toRawId(trackId);
    try {
        const res = await axios.get(
            `${config.url}/api/similar_tracks`,
            {
                params: { item_id: rawId, n },
                timeout: 15000,
                validateStatus: () => true,
            }
        );

        if (res.status === 404 || res.status === 400) {
            return { tracks: [], error: res.data?.error || "Track not found" };
        }
        if (res.status !== 200) {
            return { tracks: [], error: res.data?.error || `Request failed (${res.status})` };
        }

        const data = Array.isArray(res.data) ? res.data : [];
        const tracks: SimilarTrackResult[] = data.map((t: any) => ({
            itemId: t.item_id,
            title: t.title,
            author: t.author,
            album: t.album || "Unknown",
            distance: t.distance ?? 0,
        }));

        return { tracks };
    } catch (err: any) {
        logger.warn("[AudioMuse] getSimilarTracks error:", err.message);
        return {
            tracks: [],
            error: err.code === "ECONNREFUSED" ? "Cannot reach AudioMuse-AI" : err.message,
        };
    }
}

export interface SimilarArtistResult {
    artist: string;
    artistId: string | null;
    divergence: number;
}

/**
 * Get similar artists for a given artist
 */
export async function getSimilarArtists(
    artistIdOrName: string,
    n = 10
): Promise<{ artists: SimilarArtistResult[]; error?: string }> {
    const config = await getAudioMuseConfig();
    if (!config) return { artists: [], error: "AudioMuse-AI is not configured" };

    const rawId = toRawId(artistIdOrName);
    const param = artistIdOrName.includes(":") ? { artist_id: rawId } : { artist: artistIdOrName };

    try {
        const res = await axios.get(
            `${config.url}/api/similar_artists`,
            {
                params: { ...param, n },
                timeout: 15000,
                validateStatus: () => true,
            }
        );

        if (res.status === 404 || res.status === 400) {
            return { artists: [], error: res.data?.error || "Artist not found" };
        }
        if (res.status !== 200) {
            return { artists: [], error: res.data?.error || `Request failed (${res.status})` };
        }

        const data = Array.isArray(res.data) ? res.data : [];
        const artists: SimilarArtistResult[] = data.map((a: any) => ({
            artist: a.artist,
            artistId: a.artist_id ?? null,
            divergence: a.divergence ?? 0,
        }));

        return { artists };
    } catch (err: any) {
        logger.warn("[AudioMuse] getSimilarArtists error:", err.message);
        return {
            artists: [],
            error: err.code === "ECONNREFUSED" ? "Cannot reach AudioMuse-AI" : err.message,
        };
    }
}

export interface ArtistTrackResult {
    itemId: string;
    title: string;
    author: string;
}

/**
 * Get all tracks for an artist
 */
export async function getArtistTracks(
    artistIdOrName: string
): Promise<{ tracks: ArtistTrackResult[]; error?: string }> {
    const config = await getAudioMuseConfig();
    if (!config) return { tracks: [], error: "AudioMuse-AI is not configured" };

    const rawId = toRawId(artistIdOrName);
    const param = artistIdOrName.includes(":") ? { artist_id: rawId } : { artist: artistIdOrName };

    try {
        const res = await axios.get(
            `${config.url}/api/artist_tracks`,
            {
                params: param,
                timeout: 15000,
                validateStatus: () => true,
            }
        );

        if (res.status === 400) {
            return { tracks: [], error: res.data?.error || "Missing artist" };
        }
        if (res.status !== 200) {
            return { tracks: [], error: res.data?.error || `Request failed (${res.status})` };
        }

        const data = Array.isArray(res.data) ? res.data : [];
        const tracks: ArtistTrackResult[] = data.map((t: any) => ({
            itemId: t.item_id,
            title: t.title,
            author: t.author,
        }));

        return { tracks };
    } catch (err: any) {
        logger.warn("[AudioMuse] getArtistTracks error:", err.message);
        return {
            tracks: [],
            error: err.code === "ECONNREFUSED" ? "Cannot reach AudioMuse-AI" : err.message,
        };
    }
}

export interface AlchemyItem {
    id: string;
    op: "ADD" | "SUBTRACT";
    type: "song" | "artist";
}

/**
 * Run Song Alchemy: mix ADD/SUBTRACT items to get a curated playlist
 */
export async function runAlchemy(
    items: AlchemyItem[],
    n = 100
): Promise<{ itemIds: string[]; error?: string }> {
    const config = await getAudioMuseConfig();
    if (!config) return { itemIds: [], error: "AudioMuse-AI is not configured" };

    const addItems = items.filter((i) => i.op === "ADD");
    if (addItems.length === 0) {
        return { itemIds: [], error: "At least one ADD item is required" };
    }

    const payload = items.map((i) => ({
        id: toRawId(i.id),
        op: i.op,
        type: i.type,
    }));

    try {
        const res = await axios.post(
            `${config.url}/api/alchemy`,
            { items: payload, n },
            {
                timeout: 30000,
                headers: { "Content-Type": "application/json" },
                validateStatus: () => true,
            }
        );

        if (res.status === 400) {
            return { itemIds: [], error: res.data?.error || "Invalid request" };
        }
        if (res.status !== 200) {
            return { itemIds: [], error: res.data?.error || `Request failed (${res.status})` };
        }

        const results = res.data?.results ?? [];
        const itemIds = results
            .map((r: any) => r?.item_id)
            .filter((id: unknown): id is string => typeof id === "string");

        return { itemIds };
    } catch (err: any) {
        logger.warn("[AudioMuse] runAlchemy error:", err.message);
        return {
            itemIds: [],
            error: err.code === "ECONNREFUSED" ? "Cannot reach AudioMuse-AI" : err.message,
        };
    }
}

/**
 * Create a playlist in Jellyfin via AudioMuse-AI (or we could use Lidifin's own)
 */
export async function createPlaylistViaAudioMuse(
    playlistName: string,
    itemIds: string[]
): Promise<{ success: boolean; playlistId?: string; error?: string }> {
    const config = await getAudioMuseConfig();
    if (!config) return { success: false, error: "AudioMuse-AI is not configured" };

    const rawIds = itemIds.map(toRawId);
    if (rawIds.length === 0) return { success: false, error: "No tracks to add" };

    try {
        const res = await axios.post(
            `${config.url}/api/create_playlist`,
            { playlist_name: playlistName, track_ids: rawIds },
            {
                timeout: 15000,
                headers: { "Content-Type": "application/json" },
                validateStatus: () => true,
            }
        );

        if (res.status === 400) {
            return { success: false, error: res.data?.error || "Invalid request" };
        }
        if (res.status !== 201 && res.status !== 200) {
            return { success: false, error: res.data?.error || `Request failed (${res.status})` };
        }

        return { success: true, playlistId: res.data?.playlist_id };
    } catch (err: any) {
        logger.warn("[AudioMuse] createPlaylist error:", err.message);
        return {
            success: false,
            error: err.code === "ECONNREFUSED" ? "Cannot reach AudioMuse-AI" : err.message,
        };
    }
}
