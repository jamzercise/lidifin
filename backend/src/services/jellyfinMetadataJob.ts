/**
 * Jellyfin Metadata Job – async sync and enrichment
 *
 * Runs sync + enrich (or enrich-only) in the background. State stored in Redis
 * so the frontend can poll status without blocking the request.
 */

import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

const JOB_KEY = "jellyfin:metadata:job";
const JOB_TTL = 86400; // 24h – keep last result for a day

export type JellyfinMetadataJobStatus = "idle" | "syncing" | "enriching";

export interface JellyfinMetadataJobState {
    status: JellyfinMetadataJobStatus;
    startedAt?: number;
    /**
     * Last sign of life from the running job, refreshed on a timer.
     *
     * The job is an in-process async function while its state is in Redis, so a
     * restart leaves the state claiming to be running with nothing behind it.
     * A missing or old heartbeat is how that is detected; without it the job
     * stayed "syncing" for the full 24h TTL and the sync button never re-enabled.
     */
    heartbeatAt?: number;
    lastError?: string;
    lastSynced?: number;
    lastRemoved?: number;
    lastEnriched?: number;
    lastDurationMs?: number;
}

const DEFAULT_STATE: JellyfinMetadataJobState = { status: "idle" };

/** How often a running job reports that it is still alive. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** Missed heartbeats tolerated before a job is presumed dead. */
const HEARTBEAT_TIMEOUT_MS = 4 * HEARTBEAT_INTERVAL_MS;

/**
 * Cap for state written before heartbeats existed. A full sync plus enrichment
 * can legitimately run a long time, so this is generous; the heartbeat handles
 * it precisely from now on.
 */
const LEGACY_MAX_RUNTIME_MS = 60 * 60 * 1000;

// In-memory fallback when Redis is unavailable
let memoryState: JellyfinMetadataJobState = { ...DEFAULT_STATE };

/**
 * Whether a state claiming to be running has stopped reporting in, and so
 * belongs to a process that is no longer around.
 */
export function isJobStale(
    state: JellyfinMetadataJobState,
    now = Date.now()
): boolean {
    if (state.status === "idle") return false;
    if (state.heartbeatAt) return now - state.heartbeatAt > HEARTBEAT_TIMEOUT_MS;
    if (state.startedAt) return now - state.startedAt > LEGACY_MAX_RUNTIME_MS;
    // Running, but with no timing at all: nothing here can be trusted.
    return true;
}

async function readState(): Promise<JellyfinMetadataJobState> {
    if (redisClient.isReady) {
        try {
            const raw = await redisClient.get(JOB_KEY);
            if (raw) {
                const parsed = JSON.parse(raw) as JellyfinMetadataJobState;
                return { ...DEFAULT_STATE, ...parsed };
            }
        } catch {
            /* fall through to memory */
        }
    }
    return { ...memoryState };
}

/**
 * Current state, with an abandoned job reported as idle so a new one can start.
 */
async function getState(): Promise<JellyfinMetadataJobState> {
    const state = await readState();
    if (!isJobStale(state)) return state;

    logger.warn(
        `[JellyfinMetadataJob] Discarding a "${state.status}" job with no sign of life; it did not survive a restart`
    );
    const reclaimed: JellyfinMetadataJobState = {
        ...state,
        status: "idle",
        startedAt: undefined,
        heartbeatAt: undefined,
        lastError: "Interrupted before it finished",
    };
    await writeState(reclaimed);
    return reclaimed;
}

async function writeState(next: JellyfinMetadataJobState): Promise<void> {
    memoryState = next;
    if (redisClient.isReady) {
        try {
            await redisClient.set(JOB_KEY, JSON.stringify(next), { EX: JOB_TTL });
        } catch (err: any) {
            logger.warn("[JellyfinMetadataJob] Failed to set state:", err?.message);
        }
    }
}

async function setState(partial: Partial<JellyfinMetadataJobState>): Promise<void> {
    // Deliberately the raw read: the stale check must not rewrite state
    // underneath a job that is in the middle of updating it.
    const current = await readState();
    await writeState({ ...current, ...partial });
}

/**
 * Run a background job while reporting that it is still alive, so it is not
 * mistaken for abandoned however long it legitimately takes.
 */
async function withHeartbeat(run: () => Promise<void>): Promise<void> {
    const beat = setInterval(() => {
        void setState({ heartbeatAt: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);
    // Don't hold the process open on this timer alone.
    beat.unref?.();

    try {
        await run();
    } finally {
        clearInterval(beat);
    }
}

/** Give Redis a bounded chance to connect. Proceeds regardless once it lapses. */
async function waitForRedis(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!redisClient.isReady && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

/**
 * Clear a job left behind by a previous process.
 *
 * These jobs live only in the process that started them, so anything still
 * marked running at startup is finished whether or not its heartbeat has
 * expired yet. Called during boot so the sync button is usable immediately
 * rather than after the heartbeat timeout.
 */
export async function reclaimInterruptedJob(): Promise<void> {
    // Redis connects in the background at import time, and this runs during
    // boot. Reading too early would see the empty in-memory fallback and leave
    // the stale key in Redis untouched.
    await waitForRedis();

    const state = await readState();
    if (state.status === "idle") return;

    logger.warn(
        `[JellyfinMetadataJob] A "${state.status}" job was interrupted by a restart; clearing it`
    );
    await writeState({
        ...state,
        status: "idle",
        startedAt: undefined,
        heartbeatAt: undefined,
        lastError: "Interrupted by a restart",
    });
}

/**
 * Run sync + enrichment in the background. Returns immediately.
 * If a job is already running, does nothing (caller should check status first).
 */
export async function runSyncAndEnrich(): Promise<{ started: boolean; status: JellyfinMetadataJobStatus }> {
    const state = await getState();
    if (state.status !== "idle") {
        return { started: false, status: state.status };
    }

    await setState({
        status: "syncing",
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
        lastError: undefined,
    });

    void withHeartbeat(async () => {
        try {
            const { syncJellyfinTrackMetadata, refreshJellyfinRgMbidCache } = await import("./jellyfinMetadataSync");
            const { enrichJellyfinTrackMetadata } = await import("./jellyfinMetadataEnrichment");
            const { isJellyfinMusicSource } = await import("./jellyfin");
            const { redisClient: rc } = await import("../utils/redis");
            const LIBRARY_VIBES_CACHE_KEY = "library:vibes:counts";

            if (!(await isJellyfinMusicSource())) {
                await setState({
                    status: "idle",
                    heartbeatAt: undefined,
                    lastError: "Jellyfin is not the music source",
                });
                return;
            }

            const syncResult = await syncJellyfinTrackMetadata();
            if (!syncResult) {
                await setState({
                    status: "idle",
                    heartbeatAt: undefined,
                    lastError: "Jellyfin not configured",
                });
                return;
            }

            // Refresh the rgMbid -> Jellyfin id Redis cache used by the
            // album-detail handler. Non-fatal — point lookups fall back
            // to the bounded scan path if the cache is stale or empty.
            try {
                await refreshJellyfinRgMbidCache();
            } catch {
                /* ignore */
            }

            await setState({
                status: "enriching",
                lastSynced: syncResult.synced,
                lastRemoved: syncResult.removed,
                lastDurationMs: syncResult.durationMs,
            });

            let totalEnriched = 0;
            for (let i = 0; i < 100; i++) {
                const r = await enrichJellyfinTrackMetadata();
                if (!r || r.enriched === 0) break;
                totalEnriched += r.enriched;
            }

            if (rc.isReady) {
                try {
                    await rc.del(LIBRARY_VIBES_CACHE_KEY + ":jellyfin");
                } catch {
                    /* ignore */
                }
            }

            await setState({
                status: "idle",
                heartbeatAt: undefined,
                lastEnriched: totalEnriched,
                lastError: undefined,
            });
            logger.info(`[JellyfinMetadata] Sync+enrich complete: ${syncResult.synced} synced, ${totalEnriched} enriched`);
        } catch (err: any) {
            logger.error("[JellyfinMetadata] Sync+enrich failed:", err?.message);
            await setState({
                status: "idle",
                heartbeatAt: undefined,
                lastError: err?.message || "Unknown error",
            });
        }
    });

    return { started: true, status: "syncing" };
}

/**
 * Run enrichment only in the background. Returns immediately.
 */
export async function runEnrichOnly(): Promise<{ started: boolean; status: JellyfinMetadataJobStatus }> {
    const state = await getState();
    if (state.status !== "idle") {
        return { started: false, status: state.status };
    }

    await setState({
        status: "enriching",
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
        lastError: undefined,
    });

    void withHeartbeat(async () => {
        try {
            const { enrichJellyfinTrackMetadata } = await import("./jellyfinMetadataEnrichment");
            const { isJellyfinMusicSource } = await import("./jellyfin");
            const { redisClient: rc } = await import("../utils/redis");
            const LIBRARY_VIBES_CACHE_KEY = "library:vibes:counts";

            if (!(await isJellyfinMusicSource())) {
                await setState({
                    status: "idle",
                    heartbeatAt: undefined,
                    lastError: "Jellyfin is not the music source",
                });
                return;
            }

            let totalEnriched = 0;
            const maxIterations = 500;
            for (let i = 0; i < maxIterations; i++) {
                const r = await enrichJellyfinTrackMetadata();
                if (!r || r.enriched === 0) break;
                totalEnriched += r.enriched;
            }

            if (rc.isReady) {
                try {
                    await rc.del(LIBRARY_VIBES_CACHE_KEY + ":jellyfin");
                } catch {
                    /* ignore */
                }
            }

            await setState({
                status: "idle",
                heartbeatAt: undefined,
                lastEnriched: totalEnriched,
                lastError: undefined,
            });
            logger.info(`[JellyfinMetadata] Enrich complete: ${totalEnriched} tracks`);
        } catch (err: any) {
            logger.error("[JellyfinMetadata] Enrich failed:", err?.message);
            await setState({
                status: "idle",
                heartbeatAt: undefined,
                lastError: err?.message || "Unknown error",
            });
        }
    });

    return { started: true, status: "enriching" };
}

/**
 * Get current job status for polling.
 */
export async function getJobStatus(): Promise<JellyfinMetadataJobState> {
    return getState();
}
