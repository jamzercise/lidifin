import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

const DEFAULT_TIMEOUT_MS = 90 * 1000;
const timeoutMs =
    typeof process.env.REQUEST_TIMEOUT_MS !== "undefined"
        ? parseInt(process.env.REQUEST_TIMEOUT_MS, 10)
        : DEFAULT_TIMEOUT_MS;
const effectiveTimeout = Number.isNaN(timeoutMs) || timeoutMs <= 0 ? DEFAULT_TIMEOUT_MS : Math.min(timeoutMs, 300000);

/** Stricter timeout for list endpoints so they never hold connections for minutes (default 15s). */
const LIST_ENDPOINT_TIMEOUT_MS = 15 * 1000;

/** Longer timeout for slow endpoints (e.g. AudioMuse MCP workflow can take 2+ min). */
const LONG_TIMEOUT_MS = 180 * 1000; // 3 min

/** Paths that get the shorter list timeout (GET only). */
const LIST_PATHS: string[] = [
    "/api/library/albums",
    "/api/library/artists",
];

/** Paths that get the longer timeout (AudioMuse chatPlaylist, etc.). */
const LONG_TIMEOUT_PATHS: string[] = [
    "/api/mixes/audiomuse/instant",
];

function getTimeoutForPath(path: string, method: string): number {
    if (LONG_TIMEOUT_PATHS.some((p) => path.startsWith(p))) {
        return LONG_TIMEOUT_MS;
    }
    if (method !== "GET") return effectiveTimeout;
    const isListPath = LIST_PATHS.some((p) => path === p);
    return isListPath ? LIST_ENDPOINT_TIMEOUT_MS : effectiveTimeout;
}

/**
 * Request timeout middleware.
 * If the handler doesn't respond within the timeout, respond with 503 and log.
 * Skips streaming, health, and docs endpoints.
 * List endpoints (e.g. /api/library/albums, /api/library/artists) use a shorter timeout (15s).
 */
export function requestTimeout(overrideMs?: number) {
    return (req: Request, res: Response, next: NextFunction) => {
        const path = req.path;

        if (
            path === "/health" ||
            path === "/api/health" ||
            path.includes("/stream") ||
            path.startsWith("/api/docs")
        ) {
            return next();
        }

        const ms = overrideMs ?? getTimeoutForPath(path, req.method);

        let timeoutId: NodeJS.Timeout | null = setTimeout(() => {
            timeoutId = null;
            if (res.headersSent) return;
            logger.warn(`[RequestTimeout] ${req.method} ${path} timed out after ${ms}ms`);
            res.status(503).json({
                error: "Request timeout",
                message: "The server took too long to respond. Please try again.",
            });
        }, ms);

        const onFinish = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            res.off("finish", onFinish);
            res.off("close", onFinish);
        };

        res.once("finish", onFinish);
        res.once("close", onFinish);
        next();
    };
}
