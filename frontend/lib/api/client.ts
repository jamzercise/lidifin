export const AUTH_TOKEN_KEY = "auth_token";
export const REFRESH_TOKEN_KEY = "refresh_token";

// Mood Mix Types (Legacy - for old presets endpoint)
export interface MoodPreset {
    id: string;
    name: string;
    color: string;
    params: MoodMixParams;
}

export interface MoodMixParams {
    // Basic audio features
    valence?: { min?: number; max?: number };
    energy?: { min?: number; max?: number };
    danceability?: { min?: number; max?: number };
    acousticness?: { min?: number; max?: number };
    instrumentalness?: { min?: number; max?: number };
    arousal?: { min?: number; max?: number };
    bpm?: { min?: number; max?: number };
    keyScale?: "major" | "minor";
    // ML mood predictions (require Enhanced mode analysis)
    moodHappy?: { min?: number; max?: number };
    moodSad?: { min?: number; max?: number };
    moodRelaxed?: { min?: number; max?: number };
    moodAggressive?: { min?: number; max?: number };
    moodParty?: { min?: number; max?: number };
    moodAcoustic?: { min?: number; max?: number };
    moodElectronic?: { min?: number; max?: number };
    limit?: number;
}

// New Mood Bucket Types (simplified mood system)
export type MoodType =
    | "happy"
    | "sad"
    | "chill"
    | "energetic"
    | "party"
    | "focus"
    | "melancholy"
    | "aggressive"
    | "acoustic";

export interface MoodBucketPreset {
    id: MoodType;
    name: string;
    color: string;
    icon: string;
    trackCount: number;
}

export interface MoodBucketMix {
    id: string;
    mood: MoodType;
    name: string;
    description: string;
    trackIds: string[];
    coverUrls: string[];
    trackCount: number;
    color: string;
    tracks?: ApiData[];
}

export interface SavedMoodMixResponse {
    success: boolean;
    mix: MoodBucketMix & { generatedAt: string };
}

// Vibe (Similarity) Types
export interface SimilarTrack {
    id: string;
    title: string;
    duration: number;
    trackNo: number;
    distance: number;
    album: {
        id: string;
        title: string;
        coverUrl: string | null;
    };
    artist: {
        id: string;
        name: string;
    };
}

export interface SimilarTracksResponse {
    sourceTrackId: string;
    tracks: SimilarTrack[];
}

export interface VibeSearchResponse {
    query: string;
    tracks: SimilarTrack[];
}

export interface VibeStatusResponse {
    totalTracks: number;
    embeddedTracks: number;
    progress: number;
    isComplete: boolean;
}

export interface ApiError extends Error {
    status?: number;
    data?: Record<string, unknown>;
}

export interface ServiceTestResult {
    success?: boolean;
    version?: string;
    error?: string;
}

// API response data type - represents unvalidated JSON from the server.
// Using a single suppression here allows all 100+ API methods to return
// properly loose types without scattering suppressions across the file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ApiData = any;


export function toSearchParams(params: Record<string, string | number | boolean | undefined>): URLSearchParams {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            entries[key] = String(value);
        }
    }
    return new URLSearchParams(entries);
}

// Dynamically determine API URL based on configuration
const getApiBaseUrl = () => {
    // Server-side rendering
    if (typeof window === "undefined") {
        return process.env.BACKEND_URL || "http://127.0.0.1:3006";
    }

    // Explicit env var takes precedence
    if (process.env.NEXT_PUBLIC_API_URL) {
        return process.env.NEXT_PUBLIC_API_URL;
    }

    // Docker all-in-one mode: Use relative URLs (Next.js rewrites will proxy)
    // Port 3030 = container frontend; 31013 = common host-mapped port in Docker
    const frontendPort =
        window.location.port ||
        (window.location.protocol === "https:" ? "443" : "80");
    if (
        frontendPort === "3030" ||
        frontendPort === "31013" ||
        frontendPort === "443" ||
        frontendPort === "80"
    ) {
        // Use relative paths - Next.js rewrites will proxy to backend
        return "";
    }

    // Development mode: Backend on separate port
    const currentHost = window.location.hostname;
    const apiPort = "3006";
    return `${window.location.protocol}//${currentHost}:${apiPort}`;
};

export class ApiClient {
    private baseUrl: string;
    private token: string | null = null;
    private tokenInitialized: boolean = false;

    constructor(baseUrl?: string) {
        // Don't set baseUrl in constructor - determine it dynamically on each request
        this.baseUrl = baseUrl || "";

        // Try to load token synchronously
        if (typeof window !== "undefined") {
            this.token = localStorage.getItem(AUTH_TOKEN_KEY);
            if (this.token) {
                this.tokenInitialized = true;
            }
            // Note: Refresh token is loaded on-demand via getRefreshToken()
        }
    }

    /**
     * Initialize the auth token from storage
     * Call this early in the app lifecycle to ensure the token is loaded
     */
    async initToken(): Promise<string | null> {
        if (typeof window === "undefined") {
            return null;
        }

        const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
        if (storedToken) {
            this.token = storedToken;
        }

        this.tokenInitialized = true;
        return this.token;
    }

    /**
     * Check if token has been initialized
     */
    isTokenInitialized(): boolean {
        return this.tokenInitialized;
    }

    /**
     * Get the current token (may be null)
     */
    getToken(): string | null {
        return this.token;
    }

    // Refresh the base URL from configuration
    refreshBaseUrl(): void {
        this.baseUrl = "";
    }

    // Store JWT token and optionally refresh token
    setToken(token: string, refreshToken?: string) {
        this.token = token;
        if (typeof window !== "undefined") {
            localStorage.setItem(AUTH_TOKEN_KEY, token);
            if (refreshToken) {
                localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
            }
        }
    }

    // Get refresh token from storage
    getRefreshToken(): string | null {
        if (typeof window === "undefined") {
            return null;
        }
        return localStorage.getItem(REFRESH_TOKEN_KEY);
    }

    // Clear both JWT tokens
    clearToken() {
        this.token = null;
        if (typeof window !== "undefined") {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            localStorage.removeItem(REFRESH_TOKEN_KEY);
        }
    }

    // Get the base URL dynamically to support switching between localhost and IP
    getBaseUrl(): string {
        if (this.baseUrl) {
            return this.baseUrl;
        }
        return getApiBaseUrl();
    }

    /**
     * Get the current token, lazily loading from localStorage if needed.
     * This handles the case where the singleton was created during SSR
     * and this.token wasn't set from localStorage.
     */
    getCurrentToken(): string | null {
        // If we already have a token, use it
        if (this.token) {
            return this.token;
        }
        // Try to load from localStorage if on client
        if (typeof window !== "undefined") {
            const storedToken = localStorage.getItem(AUTH_TOKEN_KEY);
            if (storedToken) {
                this.token = storedToken;
                this.tokenInitialized = true;
                return storedToken;
            }
        }
        return null;
    }

    /**
     * Base URL for Cast requests. Must be absolute and reachable from Chromecast.
     * Prefers NEXT_PUBLIC_API_URL; otherwise uses window.location.origin.
     */
    getBaseUrlForCast(): string {
        if (typeof window === "undefined") return "";
        if (process.env.NEXT_PUBLIC_API_URL) {
            return process.env.NEXT_PUBLIC_API_URL.replace(/\/$/, "");
        }
        return window.location.origin;
    }

    /**
     * Refresh the access token using the refresh token
     * @returns true if refresh succeeded, false otherwise
     */
    private async refreshAccessToken(): Promise<boolean> {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) {
            return false;
        }

        try {
            const response = await fetch(
                `${this.getBaseUrl()}/api/auth/refresh`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refreshToken }),
                    credentials: "include",
                }
            );

            if (!response.ok) {
                // Refresh token invalid or expired - clear tokens
                this.clearToken();
                return false;
            }

            const data = await response.json();

            // Store new tokens
            if (data.token) {
                this.setToken(data.token, data.refreshToken);
                return true;
            }

            this.clearToken();
            return false;
        } catch (error) {
            console.error("[API] Token refresh failed:", error);
            this.clearToken();
            return false;
        }
    }

    /**
     * Make an authenticated API request
     * Public method for components that need custom API calls
     */
    async request<T>(
        endpoint: string,
        options: RequestInit & {
            silent404?: boolean;
            _retryCount?: number;
        } = {}
    ): Promise<T> {
        const { silent404, _retryCount = 0, ...fetchOptions } = options;
        const headers: HeadersInit = {
            "Content-Type": "application/json",
            ...fetchOptions.headers,
        };

        // Add Authorization header if token exists
        if (this.token) {
            (headers as Record<string, string>)[
                "Authorization"
            ] = `Bearer ${this.token}`;
        }

        // All API endpoints are prefixed with /api
        const url = `${this.getBaseUrl()}/api${endpoint}`;

        // Client-side timeout so the UI doesn't hang when the backend is unresponsive (e.g. ECONNRESET / hung).
        // Fail fast (30s) for most requests - user gets feedback instead of waiting minutes.
        // Exceptions: AudioMuse instant (190s), sync triggers (60s - server returns quickly, work is async).
        const isStream = endpoint.includes("/stream");
        const isLongRunning =
            endpoint.includes("/mixes/audiomuse/instant") ||
            endpoint.includes("/sync") ||
            endpoint.includes("/enrichment/full") ||
            endpoint.includes("/enrichment/sync");
        const REQUEST_TIMEOUT_MS = endpoint.includes("/mixes/audiomuse/instant")
            ? 190 * 1000
            : isLongRunning
              ? 60 * 1000
              : 30 * 1000;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const controller =
            typeof AbortController !== "undefined" && !fetchOptions.signal && !isStream
                ? new AbortController()
                : null;
        if (controller) {
            timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        }

        let response: Response;
        try {
            response = await fetch(url, {
                ...fetchOptions,
                headers,
                credentials: "include", // Still send cookies for backward compatibility
                signal: controller?.signal ?? fetchOptions.signal,
            }).finally(() => {
                if (timeoutId) clearTimeout(timeoutId);
            });
        } catch (err) {
            if (err instanceof Error) {
                if (err.name === "AbortError") {
                    throw new Error(
                        "Request timed out. The server may be overloaded. Please try again."
                    ) as ApiError;
                }
                if (
                    err.message?.includes("ECONNRESET") ||
                    err.message?.includes("socket hang up") ||
                    err.message?.includes("Failed to fetch")
                ) {
                    throw new Error(
                        "Connection lost. The server may be busy. Please try again."
                    ) as ApiError;
                }
            }
            throw err;
        }

        if (!response.ok) {
            const error = await response.json().catch(() => ({
                error: response.statusText,
            }));

            // Only log non-404 errors (404s are often expected)
            if (!(silent404 && response.status === 404)) {
                console.error(`[API] Request failed: ${url}`, error);
            }

            // Handle 401 with token refresh (retry once)
            if (
                response.status === 401 &&
                _retryCount === 0 &&
                endpoint !== "/auth/refresh"
            ) {
                const refreshed = await this.refreshAccessToken();

                if (refreshed) {
                    // Retry the request with new token
                    return this.request<T>(endpoint, {
                        ...options,
                        _retryCount: 1, // Prevent infinite loops
                    });
                }
            }

            if (response.status === 401) {
                const err = new Error("Not authenticated");
                (err as ApiError).status = response.status;
                (err as ApiError).data = error;
                throw err;
            }

            const err = new Error(error.error || "An error occurred");
            (err as ApiError).status = response.status;
            (err as ApiError).data = error;
            throw err;
        }

        const data = await response.json();
        return data;
    }

    // Generic POST method for convenience
    async post<T = unknown>(endpoint: string, data?: unknown): Promise<T> {
        return this.request<T>(endpoint, {
            method: "POST",
            body: data ? JSON.stringify(data) : undefined,
        });
    }

    // Generic GET method for convenience
    async get<T = unknown>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "GET",
        });
    }

    // Generic DELETE method for convenience
    async delete<T = unknown>(endpoint: string): Promise<T> {
        return this.request<T>(endpoint, {
            method: "DELETE",
        });
    }

    // Auth
    async login(username: string, password: string, token?: string): Promise<{
        id: string;
        username: string;
        role: string;
        requires2FA?: boolean;
        onboardingComplete?: boolean;
    }> {
        const data = await this.request<{
            token?: string;
            refreshToken?: string;
            user?: {
                id: string;
                username: string;
                role: string;
                requires2FA?: boolean;
                onboardingComplete?: boolean;
            };
            id?: string;
            username?: string;
            role?: string;
            requires2FA?: boolean;
            onboardingComplete?: boolean;
        }>("/auth/login", {
            method: "POST",
            body: JSON.stringify({ username, password, token }),
        });

        // If login returned JWT tokens, store them
        if (data.token) {
            this.setToken(data.token, data.refreshToken);
        }

        // Return user data in consistent format
        if (data.user) {
            return data.user;
        }
        return {
            id: data.id || "",
            username: data.username || "",
            role: data.role || "",
            requires2FA: data.requires2FA,
            onboardingComplete: data.onboardingComplete,
        };
    }

    async register(username: string, password: string, email?: string) {
        const data = await this.request<{
            id: string;
            username: string;
            role: string;
        }>("/auth/register", {
            method: "POST",
            body: JSON.stringify({ username, password, email }),
        });
        return data;
    }

    async logout() {
        await this.request<void>("/auth/logout", {
            method: "POST",
        });
        // Clear the stored JWT token
        this.clearToken();
    }

    async getCurrentUser() {
        return this.request<{
            id: string;
            username: string;
            role: string;
            onboardingComplete?: boolean;
            enrichmentSettings?: { enabled: boolean; lastRun?: string };
            createdAt: string;
        }>("/auth/me");
    }
}
