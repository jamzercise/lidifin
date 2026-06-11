type DependencyName = "postgres" | "redis";

export interface DependencyHealthSnapshot {
    healthy: boolean | null;
    checkedAt: string | null;
    lastError: string | null;
}

interface DependencyHealthState {
    healthy: boolean | null;
    checkedAtMs: number | null;
    lastError: string | null;
}

interface EventLoopHealthState {
    degraded: boolean;
    degradedSinceMs: number | null;
    lastCheckAtMs: number | null;
    lastDelayMs: number | null;
    recentDelays: number[];
    lastDiagnosticReportPath: string | null;
}

interface ExitState {
    requested: boolean;
    requestedAtMs: number | null;
    reason: string | null;
}

const dependencyState: Record<DependencyName, DependencyHealthState> = {
    postgres: {
        healthy: null,
        checkedAtMs: null,
        lastError: null,
    },
    redis: {
        healthy: null,
        checkedAtMs: null,
        lastError: null,
    },
};

const eventLoopState: EventLoopHealthState = {
    degraded: false,
    degradedSinceMs: null,
    lastCheckAtMs: null,
    lastDelayMs: null,
    recentDelays: [],
    lastDiagnosticReportPath: null,
};

const exitState: ExitState = {
    requested: false,
    requestedAtMs: null,
    reason: null,
};

function toIso(ms: number | null): string | null {
    return ms ? new Date(ms).toISOString() : null;
}

export function recordDependencySuccess(name: DependencyName): void {
    dependencyState[name] = {
        healthy: true,
        checkedAtMs: Date.now(),
        lastError: null,
    };
}

export function recordDependencyFailure(
    name: DependencyName,
    error: string
): void {
    dependencyState[name] = {
        healthy: false,
        checkedAtMs: Date.now(),
        lastError: error,
    };
}

export function recordEventLoopHealthy(checkAtMs = Date.now()): void {
    eventLoopState.lastCheckAtMs = checkAtMs;
    eventLoopState.lastDelayMs = 0;
    eventLoopState.recentDelays = [];
    eventLoopState.degraded = false;
    eventLoopState.degradedSinceMs = null;
}

export function recordEventLoopDelay(
    delayMs: number,
    recentDelays: number[],
    degrade: boolean,
    checkAtMs = Date.now()
): void {
    eventLoopState.lastCheckAtMs = checkAtMs;
    eventLoopState.lastDelayMs = delayMs;
    eventLoopState.recentDelays = [...recentDelays];

    if (!degrade) {
        return;
    }

    if (!eventLoopState.degraded) {
        eventLoopState.degraded = true;
        eventLoopState.degradedSinceMs = checkAtMs;
    }
}

export function recordDiagnosticReportPath(reportPath: string): void {
    eventLoopState.lastDiagnosticReportPath = reportPath;
}

export function markProcessExitRequested(reason: string): void {
    exitState.requested = true;
    exitState.requestedAtMs = Date.now();
    exitState.reason = reason;
}

export function getRuntimeHealthSnapshot(): {
    status: "ok" | "degraded";
    checkedAt: string;
    eventLoop: {
        degraded: boolean;
        degradedSince: string | null;
        lastCheckAt: string | null;
        lastDelayMs: number | null;
        recentDelays: number[];
        lastDiagnosticReportPath: string | null;
    };
    dependencies: Record<DependencyName, DependencyHealthSnapshot>;
    exit: {
        requested: boolean;
        requestedAt: string | null;
        reason: string | null;
    };
    reasons: string[];
} {
    const reasons: string[] = [];

    if (eventLoopState.degraded) {
        reasons.push("event_loop_degraded");
    }

    for (const [name, state] of Object.entries(dependencyState) as Array<
        [DependencyName, DependencyHealthState]
    >) {
        if (state.healthy === false) {
            reasons.push(`${name}_unhealthy`);
        } else if (state.healthy === null) {
            reasons.push(`${name}_pending`);
        }
    }

    if (exitState.requested) {
        reasons.push("process_exit_requested");
    }

    return {
        status: reasons.length === 0 ? "ok" : "degraded",
        checkedAt: new Date().toISOString(),
        eventLoop: {
            degraded: eventLoopState.degraded,
            degradedSince: toIso(eventLoopState.degradedSinceMs),
            lastCheckAt: toIso(eventLoopState.lastCheckAtMs),
            lastDelayMs: eventLoopState.lastDelayMs,
            recentDelays: [...eventLoopState.recentDelays],
            lastDiagnosticReportPath: eventLoopState.lastDiagnosticReportPath,
        },
        dependencies: {
            postgres: {
                healthy: dependencyState.postgres.healthy,
                checkedAt: toIso(dependencyState.postgres.checkedAtMs),
                lastError: dependencyState.postgres.lastError,
            },
            redis: {
                healthy: dependencyState.redis.healthy,
                checkedAt: toIso(dependencyState.redis.checkedAtMs),
                lastError: dependencyState.redis.lastError,
            },
        },
        exit: {
            requested: exitState.requested,
            requestedAt: toIso(exitState.requestedAtMs),
            reason: exitState.reason,
        },
        reasons,
    };
}
