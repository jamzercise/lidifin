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
    lastError?: string;
    lastSynced?: number;
    lastRemoved?: number;
    lastEnriched?: number;
    lastDurationMs?: number;
}

const DEFAULT_STATE: JellyfinMetadataJobState = { status: "idle" };

// In-memory fallback when Redis is unavailable
let memoryState: JellyfinMetadataJobState = { ...DEFAULT_STATE };

async function getState(): Promise<JellyfinMetadataJobState> {
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

async function setState(partial: Partial<JellyfinMetadataJobState>): Promise<void> {
    const current = await getState();
    const next = { ...current, ...partial };
    memoryState = next;
    if (redisClient.isReady) {
        try {
            await redisClient.set(JOB_KEY, JSON.stringify(next), { EX: JOB_TTL });
        } catch (err: any) {
            logger.warn("[JellyfinMetadataJob] Failed to set state:", err?.message);
        }
    }
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

    await setState({ status: "syncing", startedAt: Date.now(), lastError: undefined });

    (async () => {
        try {
            const { syncJellyfinTrackMetadata, refreshJellyfinRgMbidCache } = await import("./jellyfinMetadataSync");
            const { enrichJellyfinTrackMetadata } = await import("./jellyfinMetadataEnrichment");
            const { isJellyfinMusicSource } = await import("./jellyfin");
            const { redisClient: rc } = await import("../utils/redis");
            const LIBRARY_VIBES_CACHE_KEY = "library:vibes:counts";

            if (!(await isJellyfinMusicSource())) {
                await setState({ status: "idle", lastError: "Jellyfin is not the music source" });
                return;
            }

            const syncResult = await syncJellyfinTrackMetadata();
            if (!syncResult) {
                await setState({ status: "idle", lastError: "Jellyfin not configured" });
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
                lastEnriched: totalEnriched,
                lastError: undefined,
            });
            logger.info(`[JellyfinMetadata] Sync+enrich complete: ${syncResult.synced} synced, ${totalEnriched} enriched`);
        } catch (err: any) {
            logger.error("[JellyfinMetadata] Sync+enrich failed:", err?.message);
            await setState({ status: "idle", lastError: err?.message || "Unknown error" });
        }
    })();

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

    await setState({ status: "enriching", startedAt: Date.now(), lastError: undefined });

    (async () => {
        try {
            const { enrichJellyfinTrackMetadata } = await import("./jellyfinMetadataEnrichment");
            const { isJellyfinMusicSource } = await import("./jellyfin");
            const { redisClient: rc } = await import("../utils/redis");
            const LIBRARY_VIBES_CACHE_KEY = "library:vibes:counts";

            if (!(await isJellyfinMusicSource())) {
                await setState({ status: "idle", lastError: "Jellyfin is not the music source" });
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
                lastEnriched: totalEnriched,
                lastError: undefined,
            });
            logger.info(`[JellyfinMetadata] Enrich complete: ${totalEnriched} tracks`);
        } catch (err: any) {
            logger.error("[JellyfinMetadata] Enrich failed:", err?.message);
            await setState({ status: "idle", lastError: err?.message || "Unknown error" });
        }
    })();

    return { started: true, status: "enriching" };
}

/**
 * Get current job status for polling.
 */
export async function getJobStatus(): Promise<JellyfinMetadataJobState> {
    return getState();
}
