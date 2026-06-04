// Side-effect imports register prototype methods on ApiClient
import "./library";
import "./playlists";
import "./podcasts";
import "./discover";
import "./releases";
import "./audiobooks";
import "./player";
import "./settings";
import "./mixes";
import "./search";
import "./vibe";
import "./audiomuse";
import "./notifications";

import { ApiClient } from "./client";

export { ApiClient, AUTH_TOKEN_KEY, REFRESH_TOKEN_KEY, toSearchParams } from "./client";
export type {
    MoodPreset,
    MoodMixParams,
    MoodType,
    MoodBucketPreset,
    MoodBucketMix,
    SavedMoodMixResponse,
    SimilarTrack,
    SimilarTracksResponse,
    VibeSearchResponse,
    VibeStatusResponse,
    ApiError,
    ServiceTestResult,
    ApiData,
} from "./client";

// Create a singleton instance without passing baseUrl - it will be determined dynamically
const api = new ApiClient();
export { api };
