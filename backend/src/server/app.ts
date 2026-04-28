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

    app.use(
        cors({
            origin: (origin, callback) => {
                // Self-hosted apps run on user-controlled domains/IPs we can't
                // predict; security comes from authentication, not CORS. Allow
                // by default and log when origin is unknown.
                if (!origin) {
                    callback(null, true);
                } else if (
                    config.allowedOrigins === true ||
                    config.nodeEnv === "development"
                ) {
                    callback(null, true);
                } else if (
                    Array.isArray(config.allowedOrigins) &&
                    config.allowedOrigins.length > 0
                ) {
                    if (config.allowedOrigins.includes(origin)) {
                        callback(null, true);
                    } else {
                        logger.debug(
                            `[CORS] Origin ${origin} not in allowlist, allowing anyway (self-hosted)`
                        );
                        callback(null, true);
                    }
                } else {
                    callback(null, true);
                }
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
