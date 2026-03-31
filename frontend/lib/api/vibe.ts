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
            debug?: {
                matchedTerms: string[];
                genreConfidence: number;
                featureWeight: number;
            };
        }>;
        getVibeStatus(): Promise<{ totalTracks: number; embeddedTracks: number; progress: number; isComplete: boolean }>;
        getTrackAnalysis(trackId: string): Promise<{
            id: string;
            title: string;
            analysisStatus: string;
            analysisError: string | null;
            analyzedAt: string | null;
            analysisVersion: string | null;
            analysisMode: string | null;
            bpm: number | null;
            beatsCount: number | null;
            key: string | null;
            keyScale: string | null;
            keyStrength: number | null;
            energy: number | null;
            loudness: number | null;
            dynamicRange: number | null;
            danceability: number | null;
            valence: number | null;
            arousal: number | null;
            instrumentalness: number | null;
            acousticness: number | null;
            speechiness: number | null;
            moodHappy: number | null;
            moodSad: number | null;
            moodRelaxed: number | null;
            moodAggressive: number | null;
            moodParty: number | null;
            moodAcoustic: number | null;
            moodElectronic: number | null;
            moodTags: string[] | null;
            essentiaGenres: string[] | null;
            lastfmTags: string[] | null;
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

ApiClient.prototype.getTrackAnalysis = async function (this: ApiClient, trackId: string) {
    return this.request(`/analysis/track/${trackId}`);
};
