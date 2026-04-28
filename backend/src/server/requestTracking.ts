import type { Request, Response, NextFunction } from "express";

/**
 * Tracks the most recent in-flight request so the event-loop monitor
 * can attribute a delay to the handler that was running when the loop
 * blocked. Exposed as a module-level mutable for read-only use by
 * eventLoopMonitor.
 */
export interface CurrentRequestInfo {
    method: string;
    path: string;
    at: number;
}

let currentRequestInfo: CurrentRequestInfo | null = null;

export function getCurrentRequestInfo(): CurrentRequestInfo | null {
    return currentRequestInfo;
}

export function trackRequestMiddleware() {
    return (req: Request, res: Response, next: NextFunction) => {
        currentRequestInfo = {
            method: req.method,
            path: req.path,
            at: Date.now(),
        };
        const clear = () => {
            currentRequestInfo = null;
        };
        res.once("finish", clear);
        res.once("close", clear);
        next();
    };
}
