import { logger } from "../utils/logger";
import { getCurrentRequestInfo } from "./requestTracking";

/**
 * Periodically samples scheduling latency to detect blocked event-loop
 * conditions (sync work, runaway loops, slow native modules). When a
 * delay is detected, attribute it to the in-flight request (if any)
 * for easier diagnosis.
 *
 * On severe degradation we exit the process so Docker's restart policy
 * recreates a fresh one — the loop is unrecoverable in-place at that
 * point. Configurable via env vars:
 *   EVENT_LOOP_EXIT_DELAY_MS         (default 5min)
 *   EVENT_LOOP_EXIT_REQUESTS         (default 800)
 *   EVENT_LOOP_EXIT_ON_SEVERE_DEGRADATION=false  to disable auto-exit
 */
const EVENT_LOOP_CHECK_MS = 30000;
const EVENT_LOOP_WARN_THRESHOLD_MS = 2000;
const MAX_RECENT_DELAYS = 5;

const EVENT_LOOP_EXIT_DELAY_MS =
    typeof process.env.EVENT_LOOP_EXIT_DELAY_MS !== "undefined"
        ? parseInt(process.env.EVENT_LOOP_EXIT_DELAY_MS, 10)
        : 5 * 60 * 1000;
const EVENT_LOOP_EXIT_REQUESTS =
    typeof process.env.EVENT_LOOP_EXIT_REQUESTS !== "undefined"
        ? parseInt(process.env.EVENT_LOOP_EXIT_REQUESTS, 10)
        : 800;
const EVENT_LOOP_EXIT_ENABLED =
    process.env.EVENT_LOOP_EXIT_ON_SEVERE_DEGRADATION !== "false";

function getEventLoopDiagnostics(): Record<string, unknown> {
    const mem = process.memoryUsage();
    const diagnostics: Record<string, unknown> = {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        externalMB: Math.round((mem.external || 0) / 1024 / 1024),
    };
    try {
        const handles = (process as NodeJS.Process & {
            _getActiveHandles?: () => unknown[];
        })._getActiveHandles?.();
        const requests = (process as NodeJS.Process & {
            _getActiveRequests?: () => unknown[];
        })._getActiveRequests?.();
        if (handles) diagnostics.activeHandles = handles.length;
        if (requests) diagnostics.activeRequests = requests.length;
    } catch {
        // Internal Node accessors may not exist or can throw.
    }
    return diagnostics;
}

export function startEventLoopMonitor(): void {
    // Seed expected time so the first tick doesn't always look like a
    // 30s delay just because of startup work.
    let eventLoopCheckExpected = Date.now() + EVENT_LOOP_CHECK_MS;
    const recentDelays: number[] = [];

    setInterval(() => {
        const now = Date.now();
        const delay = now - eventLoopCheckExpected;
        eventLoopCheckExpected = now + EVENT_LOOP_CHECK_MS;
        if (delay <= EVENT_LOOP_WARN_THRESHOLD_MS) return;

        recentDelays.push(delay);
        if (recentDelays.length > MAX_RECENT_DELAYS) recentDelays.shift();

        const reqInfo = getCurrentRequestInfo();
        const reqInfoStr = reqInfo
            ? ` Request in progress: ${reqInfo.method} ${reqInfo.path} (started ${now - reqInfo.at}ms ago).`
            : " (no request in progress when checked)";

        const diagnostics = getEventLoopDiagnostics();
        logger.warn(
            `[EventLoop] Delay detected: ${delay}ms (expected ~${EVENT_LOOP_CHECK_MS}ms). Backend event loop was blocked.${reqInfoStr}`,
            { diagnostics, recentDelays: [...recentDelays] }
        );

        if (EVENT_LOOP_EXIT_ENABLED) {
            const activeRequests = (diagnostics.activeRequests as number) ?? 0;
            const shouldExit =
                delay >= EVENT_LOOP_EXIT_DELAY_MS ||
                activeRequests >= EVENT_LOOP_EXIT_REQUESTS;
            if (shouldExit) {
                logger.error(
                    `[EventLoop] Severe degradation detected (delay=${delay}ms, activeRequests=${activeRequests}). ` +
                        `Exiting to trigger container restart. Set EVENT_LOOP_EXIT_ON_SEVERE_DEGRADATION=false to disable.`
                );
                process.exit(1);
            }
        }
    }, EVENT_LOOP_CHECK_MS);
}
