import { promises as fs } from "fs";
import path from "path";
import { logger } from "../utils/logger";
import { getCurrentRequestInfo } from "./requestTracking";
import {
    markProcessExitRequested,
    recordDiagnosticReportPath,
    recordEventLoopDelay,
    recordEventLoopHealthy,
} from "./runtimeHealth";

/**
 * Periodically samples scheduling latency to detect blocked event-loop
 * conditions (sync work, runaway loops, slow native modules). When a
 * delay is detected, attribute it to the in-flight request (if any)
 * for easier diagnosis.
 *
 * On severe degradation we exit the process so Docker's restart policy
 * recreates a fresh one — the loop is unrecoverable in-place at that
 * point. Configurable via env vars:
 *   EVENT_LOOP_EXIT_DELAY_MS         (default 60s)
 *   EVENT_LOOP_EXIT_REQUESTS         (default 150)
 *   EVENT_LOOP_EXIT_ON_SEVERE_DEGRADATION=false  to disable auto-exit
 */
const EVENT_LOOP_CHECK_MS = 30000;
const EVENT_LOOP_WARN_THRESHOLD_MS = 2000;
const MAX_RECENT_DELAYS = 5;
const DEFAULT_EVENT_LOOP_EXIT_DELAY_MS = 60 * 1000;
const DEFAULT_EVENT_LOOP_EXIT_REQUESTS = 150;
const DEFAULT_EVENT_LOOP_HEALTH_DEGRADE_MS = 10 * 1000;
const DEFAULT_EVENT_LOOP_REPORT_DELAY_MS = 15 * 1000;
const DEFAULT_EVENT_LOOP_REPORT_COOLDOWN_MS = 5 * 60 * 1000;

function parseEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (typeof raw === "undefined") return fallback;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const EVENT_LOOP_EXIT_DELAY_MS = parseEnvInt(
    "EVENT_LOOP_EXIT_DELAY_MS",
    DEFAULT_EVENT_LOOP_EXIT_DELAY_MS
);
const EVENT_LOOP_EXIT_REQUESTS = parseEnvInt(
    "EVENT_LOOP_EXIT_REQUESTS",
    DEFAULT_EVENT_LOOP_EXIT_REQUESTS
);
const EVENT_LOOP_HEALTH_DEGRADE_MS = parseEnvInt(
    "EVENT_LOOP_HEALTH_DEGRADE_MS",
    DEFAULT_EVENT_LOOP_HEALTH_DEGRADE_MS
);
const EVENT_LOOP_REPORT_DELAY_MS = parseEnvInt(
    "EVENT_LOOP_REPORT_DELAY_MS",
    DEFAULT_EVENT_LOOP_REPORT_DELAY_MS
);
const EVENT_LOOP_REPORT_COOLDOWN_MS = parseEnvInt(
    "EVENT_LOOP_REPORT_COOLDOWN_MS",
    DEFAULT_EVENT_LOOP_REPORT_COOLDOWN_MS
);
const EVENT_LOOP_EXIT_ENABLED =
    process.env.EVENT_LOOP_EXIT_ON_SEVERE_DEGRADATION !== "false";
const EVENT_LOOP_REPORT_ENABLED =
    process.env.EVENT_LOOP_WRITE_REPORT !== "false";
const EVENT_LOOP_REPORT_DIR =
    process.env.EVENT_LOOP_REPORT_DIR ||
    path.join(process.cwd(), "logs", "diagnostics");

let lastDiagnosticReportAt = 0;

function summarizeObjectTypes(items: unknown[] | undefined): Record<string, number> {
    if (!items || items.length === 0) return {};

    const counts: Record<string, number> = {};
    for (const item of items) {
        const ctor = item && typeof item === "object" && "constructor" in item
            ? (item as { constructor?: { name?: string } }).constructor?.name
            : undefined;
        const name = ctor || typeof item;
        counts[name] = (counts[name] || 0) + 1;
    }
    return counts;
}

function getEventLoopDiagnostics(): Record<string, unknown> {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    const diagnostics: Record<string, unknown> = {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
        externalMB: Math.round((mem.external || 0) / 1024 / 1024),
        cpuUserMs: Math.round(cpu.user / 1000),
        cpuSystemMs: Math.round(cpu.system / 1000),
        uptimeSec: Math.round(process.uptime()),
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
        if (handles) diagnostics.activeHandleTypes = summarizeObjectTypes(handles);
        if (requests)
            diagnostics.activeRequestTypes = summarizeObjectTypes(requests);
    } catch {
        // Internal Node accessors may not exist or can throw.
    }
    return diagnostics;
}

async function maybeWriteDiagnosticReport(
    delay: number,
    activeRequests: number,
    force = false
): Promise<void> {
    if (!EVENT_LOOP_REPORT_ENABLED) return;
    if (
        !force &&
        delay < EVENT_LOOP_REPORT_DELAY_MS &&
        activeRequests < EVENT_LOOP_EXIT_REQUESTS
    ) {
        return;
    }

    const now = Date.now();
    if (!force && now - lastDiagnosticReportAt < EVENT_LOOP_REPORT_COOLDOWN_MS) {
        return;
    }

    lastDiagnosticReportAt = now;

    try {
        await fs.mkdir(EVENT_LOOP_REPORT_DIR, { recursive: true });
        const timestamp = new Date(now).toISOString().replace(/[:.]/g, "-");
        const reportPath = path.join(
            EVENT_LOOP_REPORT_DIR,
            `event-loop-${timestamp}.json`
        );
        const reportApi = (process as NodeJS.Process & {
            report?: { writeReport?: (filename?: string) => string };
        }).report;

        if (!reportApi?.writeReport) {
            logger.warn(
                "[EventLoop] process.report.writeReport is unavailable on this runtime"
            );
            return;
        }

        const writtenPath = reportApi.writeReport(reportPath);
        recordDiagnosticReportPath(writtenPath);
        logger.error(
            `[EventLoop] Wrote diagnostic report to ${writtenPath} (delay=${delay}ms, activeRequests=${activeRequests})`
        );
    } catch (error) {
        lastDiagnosticReportAt = 0;
        logger.error("[EventLoop] Failed to write diagnostic report:", error);
    }
}

export function startEventLoopMonitor(): void {
    // Seed expected time so the first tick doesn't always look like a
    // 30s delay just because of startup work.
    let eventLoopCheckExpected = Date.now() + EVENT_LOOP_CHECK_MS;
    const recentDelays: number[] = [];

    const timer = setInterval(async () => {
        const now = Date.now();
        const delay = now - eventLoopCheckExpected;
        eventLoopCheckExpected = now + EVENT_LOOP_CHECK_MS;
        if (delay <= EVENT_LOOP_WARN_THRESHOLD_MS) {
            recordEventLoopHealthy(now);
            return;
        }

        recentDelays.push(delay);
        if (recentDelays.length > MAX_RECENT_DELAYS) recentDelays.shift();

        const reqInfo = getCurrentRequestInfo();
        const reqInfoStr = reqInfo
            ? ` Request in progress: ${reqInfo.method} ${reqInfo.path} (started ${now - reqInfo.at}ms ago).`
            : " (no request in progress when checked)";

        const diagnostics = getEventLoopDiagnostics();
        const activeRequests = (diagnostics.activeRequests as number) ?? 0;
        const degraded = delay >= EVENT_LOOP_HEALTH_DEGRADE_MS;

        recordEventLoopDelay(delay, recentDelays, degraded, now);
        logger.warn(
            `[EventLoop] Delay detected: ${delay}ms (expected ~${EVENT_LOOP_CHECK_MS}ms). Backend event loop was blocked.${reqInfoStr}`,
            { diagnostics, recentDelays: [...recentDelays] }
        );

        await maybeWriteDiagnosticReport(delay, activeRequests);

        if (EVENT_LOOP_EXIT_ENABLED) {
            const shouldExit =
                delay >= EVENT_LOOP_EXIT_DELAY_MS ||
                activeRequests >= EVENT_LOOP_EXIT_REQUESTS;
            if (shouldExit) {
                const reason = `event-loop severe degradation (delay=${delay}ms, activeRequests=${activeRequests})`;
                markProcessExitRequested(reason);
                await maybeWriteDiagnosticReport(delay, activeRequests, true);
                logger.error(
                    `[EventLoop] Severe degradation detected (delay=${delay}ms, activeRequests=${activeRequests}). ` +
                        `Exiting to trigger container restart. Set EVENT_LOOP_EXIT_ON_SEVERE_DEGRADATION=false to disable.`
                );
                process.exit(1);
            }
        }
    }, EVENT_LOOP_CHECK_MS);

    timer.unref?.();
}
