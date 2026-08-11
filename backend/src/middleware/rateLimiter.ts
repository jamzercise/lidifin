import rateLimit from "express-rate-limit";

// Trust proxy validation is disabled because this is a self-hosted app
// running behind a reverse proxy (nginx/traefik in Docker). The app.set("trust proxy", true)
// setting is required for proper IP detection and session cookies to work.
// Since this is self-hosted (not a public API), IP spoofing to bypass rate limiting is not a concern.
const trustProxyValidation = { validate: { trustProxy: false } };

// General API rate limiter (5000 req/minute per IP)
// This is for a single-user self-hosted app, so limits should be VERY high
// Only exists to prevent infinite loops or bugs from DOS'ing the server
export const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 5000, // Very high limit - personal app, not a public API
    message: "Too many requests from this IP, please try again later.",
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    skip: (req) => {
        // Never rate limit streaming, status polling, or health endpoints
        // Use precise path matching to prevent bypass via path manipulation
        const path = req.path;
        return (
            path === "/health" ||
            path === "/api/health" ||
            // Track streaming: /api/library/tracks/:id/stream
            (path.startsWith("/api/library/tracks/") && path.endsWith("/stream")) ||
            // Podcast streaming: /api/podcasts/:podcastId/episodes/:episodeId/stream
            (path.startsWith("/api/podcasts/") && path.endsWith("/stream")) ||
            // Soulseek search polling: /api/soulseek/search/:searchId (no /status suffix)
            /^\/api\/soulseek\/search\/[a-f0-9-]+$/.test(path) ||
            // Spotify import status: /api/spotify/import/:jobId/status
            /^\/api\/spotify\/import\/[a-zA-Z0-9_-]+\/status$/.test(path) ||
            // In-flight import polling: /api/spotify/imports/active
            path === "/api/spotify/imports/active" ||
            // Import progress/history polling: /api/spotify/imports/recent
            path === "/api/spotify/imports/recent"
        );
    },
    ...trustProxyValidation,
});

// Auth limiter for login endpoints (20 attempts/15min per IP)
// More lenient for self-hosted apps where users may have password manager issues
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // Increased from 5 for self-hosted environments
    skipSuccessfulRequests: true, // Don't count successful requests
    message: "Too many login attempts, please try again in 15 minutes.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});


// Image/Cover art limiter (very high limit: 500 req/minute)
// This is for image proxying - not a security risk, just bandwidth
export const imageLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 500, // Allow 500 image requests per minute (high volume pages need this)
    message: "Too many image requests, please slow down.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});

// Download limiter (100 req/minute)
// Users might download entire discographies, so this needs to be reasonable
export const downloadLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100,
    message: "Too many download requests, please try again later.",
    standardHeaders: true,
    legacyHeaders: false,
    ...trustProxyValidation,
});
