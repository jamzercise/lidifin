import type { Express, Request, Response } from "express";
import swaggerUi from "swagger-ui-express";
import { config } from "../config";
import { swaggerSpec } from "../config/swagger";
import { errorHandler } from "../middleware/errorHandler";
import { requireAuth } from "../middleware/auth";
import {
    apiLimiter,
    authLimiter,
} from "../middleware/rateLimiter";

import authRoutes from "../routes/auth";
import onboardingRoutes from "../routes/onboarding";
import libraryRoutes from "../routes/library";
import playsRoutes from "../routes/plays";
import settingsRoutes from "../routes/settings";
import systemSettingsRoutes from "../routes/systemSettings";
import listeningStateRoutes from "../routes/listeningState";
import playbackStateRoutes from "../routes/playbackState";
import offlineRoutes from "../routes/offline";
import playlistsRoutes from "../routes/playlists";
import searchRoutes from "../routes/search";
import recommendationsRoutes from "../routes/recommendations";
import downloadsRoutes from "../routes/downloads";
import webhooksRoutes from "../routes/webhooks";
import audiobooksRoutes from "../routes/audiobooks";
import podcastsRoutes from "../routes/podcasts";
import artistsRoutes from "../routes/artists";
import soulseekRoutes from "../routes/soulseek";
import discoverRoutes from "../routes/discover";
import apiKeysRoutes from "../routes/apiKeys";
import mixesRoutes from "../routes/mixes";
import enrichmentRoutes from "../routes/enrichment";
import homepageRoutes from "../routes/homepage";
import deviceLinkRoutes from "../routes/deviceLink";
import spotifyRoutes from "../routes/spotify";
import notificationsRoutes from "../routes/notifications";
import browseRoutes from "../routes/browse";
import analysisRoutes from "../routes/analysis";
import releasesRoutes from "../routes/releases";
import vibeRoutes from "../routes/vibe";
import systemRoutes from "../routes/system";

/**
 * Mount all HTTP routes onto the app. Auth routes get a stricter rate
 * limiter; most others get the general API limiter. A few endpoints
 * (library, playback-state, audiobooks, webhooks) opt out or apply
 * their own internally.
 *
 * The error handler is registered last so it catches errors from
 * every route.
 */
export function registerRoutes(app: Express): void {
    // Auth routes (with stricter limiter on login/register).
    app.use("/api/auth/login", authLimiter);
    app.use("/api/auth/register", authLimiter);
    app.use("/api/auth", authRoutes);
    app.use("/api/onboarding", onboardingRoutes);

    // General API routes.
    app.use("/api/api-keys", apiLimiter, apiKeysRoutes);
    app.use("/api/device-link", apiLimiter, deviceLinkRoutes);
    // /api/library has its own rate limiting (imageLimiter for cover-art).
    app.use("/api/library", libraryRoutes);
    app.use("/api/plays", apiLimiter, playsRoutes);
    app.use("/api/settings", apiLimiter, settingsRoutes);
    app.use("/api/system-settings", apiLimiter, systemSettingsRoutes);
    app.use("/api/listening-state", apiLimiter, listeningStateRoutes);
    // playback-state syncs frequently — no rate limit.
    app.use("/api/playback-state", playbackStateRoutes);
    app.use("/api/offline", apiLimiter, offlineRoutes);
    app.use("/api/playlists", apiLimiter, playlistsRoutes);
    app.use("/api/search", apiLimiter, searchRoutes);
    app.use("/api/recommendations", apiLimiter, recommendationsRoutes);
    app.use("/api/downloads", apiLimiter, downloadsRoutes);
    app.use("/api/notifications", apiLimiter, notificationsRoutes);
    // Webhooks must not be rate limited.
    app.use("/api/webhooks", webhooksRoutes);
    // /api/audiobooks has its own rate limiting (imageLimiter for covers).
    app.use("/api/audiobooks", audiobooksRoutes);
    app.use("/api/podcasts", apiLimiter, podcastsRoutes);
    app.use("/api/artists", apiLimiter, artistsRoutes);
    app.use("/api/soulseek", apiLimiter, soulseekRoutes);
    app.use("/api/discover", apiLimiter, discoverRoutes);
    app.use("/api/mixes", apiLimiter, mixesRoutes);
    app.use("/api/enrichment", apiLimiter, enrichmentRoutes);
    app.use("/api/homepage", apiLimiter, homepageRoutes);
    app.use("/api/spotify", apiLimiter, spotifyRoutes);
    app.use("/api/browse", apiLimiter, browseRoutes);
    app.use("/api/analysis", apiLimiter, analysisRoutes);
    app.use("/api/releases", apiLimiter, releasesRoutes);
    app.use("/api/vibe", apiLimiter, vibeRoutes);
    app.use("/api/system", apiLimiter, systemRoutes);

    // Container health checks (kept at root + /api).
    app.get("/health", (_req: Request, res: Response) => {
        res.json({ status: "ok" });
    });
    app.get("/api/health", (_req: Request, res: Response) => {
        res.json({ status: "ok" });
    });

    // Swagger docs: require auth in prod unless DOCS_PUBLIC=true.
    const docsMiddleware =
        config.nodeEnv === "production" && process.env.DOCS_PUBLIC !== "true"
            ? [requireAuth]
            : [];

    app.use(
        "/api/docs",
        ...docsMiddleware,
        swaggerUi.serve,
        swaggerUi.setup(swaggerSpec, {
            customCss: ".swagger-ui .topbar { display: none }",
            customSiteTitle: "Lidifin API Documentation",
        })
    );

    app.get("/api/docs.json", ...docsMiddleware, (_req: Request, res: Response) => {
        res.json(swaggerSpec);
    });

    app.use(errorHandler);
}
