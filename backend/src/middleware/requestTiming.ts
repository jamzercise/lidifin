/**
 * Request timing middleware.
 * Logs slow requests (>500ms) to help identify bottlenecks.
 * Enable verbose logging with ?timing=1 query param (logs all requests).
 */

import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

const SLOW_THRESHOLD_MS = 500;

/** Paths to always log (key library/playlist routes). */
const PROFILED_PATHS = [
    "/api/library/artists",
    "/api/library/albums",
    "/api/library/artists/",
    "/api/library/albums/",
    "/api/playlists/",
];

function shouldLog(path: string, req: Request): boolean {
    const verbose = req.query?.timing === "1" || req.query?.timing === "true";
    if (verbose) return true;
    return PROFILED_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export function requestTiming() {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!shouldLog(req.path, req)) return next();

        const start = Date.now();
        const onFinish = () => {
            const duration = Date.now() - start;
            if (duration >= SLOW_THRESHOLD_MS || req.query?.timing) {
                logger.info(`[Perf] ${req.method} ${req.path} ${duration}ms`);
            }
            res.off("finish", onFinish);
            res.off("close", onFinish);
        };
        res.once("finish", onFinish);
        res.once("close", onFinish);
        next();
    };
}
