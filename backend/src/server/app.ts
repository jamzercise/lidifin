import express, { type Express } from "express";
import session from "express-session";
import RedisStore from "connect-redis";
import cors from "cors";
import helmet from "helmet";
import { config } from "../config";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { requestTimeout } from "../middleware/requestTimeout";
import { requestTiming } from "../middleware/requestTiming";
import { trackRequestMiddleware } from "./requestTracking";

/**
 * Build the Express application: security headers, CORS, body parsing,
 * request tracking, sessions, and shared request middleware.
 *
 * Routes are mounted separately by `registerRoutes()`.
 */
export function createApp(): Express {
    const app = express();

    app.use(
        helmet({
            crossOriginResourcePolicy: { policy: "cross-origin" },
        })
    );

    // Warn once at startup if production is running without an allowlist, so
    // operators know cross-origin credentialed requests are being permitted.
    if (
        config.nodeEnv !== "development" &&
        !(Array.isArray(config.allowedOrigins) && config.allowedOrigins.length > 0) &&
        config.allowedOrigins !== true
    ) {
        logger.warn(
            "[CORS] No ALLOWED_ORIGINS configured in production — cross-origin " +
                "requests are being allowed. Set ALLOWED_ORIGINS to lock this down."
        );
    }

    app.use(
        cors({
            origin: (origin, callback) => {
                // No Origin header: same-origin requests, native apps, and
                // server-to-server callers. Always allowed.
                if (!origin) {
                    return callback(null, true);
                }

                // Development, or an explicit "allow all" (ALLOWED_ORIGINS unset
                // in dev): allow any origin.
                if (
                    config.allowedOrigins === true ||
                    config.nodeEnv === "development"
                ) {
                    return callback(null, true);
                }

                // Production with a configured allowlist: enforce it strictly.
                // Reflecting arbitrary origins while credentials:true is on
                // would defeat the browser's cross-origin protections.
                if (
                    Array.isArray(config.allowedOrigins) &&
                    config.allowedOrigins.length > 0
                ) {
                    if (config.allowedOrigins.includes(origin)) {
                        return callback(null, true);
                    }
                    logger.warn(
                        `[CORS] Rejected origin not in ALLOWED_ORIGINS: ${origin}`
                    );
                    return callback(null, false);
                }

                // Production without any allowlist configured: preserve
                // out-of-the-box behavior (the frontend is typically served
                // same-origin via the Next.js proxy). The startup warning above
                // nudges operators to configure ALLOWED_ORIGINS.
                return callback(null, true);
            },
            credentials: true,
        })
    );

    // 1mb limit supports large queue payloads (default 100KB was too small).
    app.use(express.json({ limit: "1mb" }));

    app.use(trackRequestMiddleware());

    // Trust all proxies in the chain (common in Docker/Portainer setups
    // behind nginx/traefik).
    app.set("trust proxy", true);

    app.use(
        session({
            store: new RedisStore({
                client: redisClient,
                ttl: 7 * 24 * 60 * 60,
            }),
            secret: config.sessionSecret,
            resave: false,
            saveUninitialized: false,
            proxy: true,
            cookie: {
                httpOnly: true,
                // Default to HTTP-friendly settings; opt in to secure cookies
                // when running behind an HTTPS reverse proxy.
                secure: process.env.SECURE_COOKIES === "true",
                sameSite: "lax",
                maxAge: 1000 * 60 * 60 * 24 * 7,
            },
        })
    );

    app.use(requestTimeout());
    app.use(requestTiming());

    return app;
}
