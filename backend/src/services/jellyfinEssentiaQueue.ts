/**
 * Arch-X.b.W — Queue Jellyfin-sourced tracks for the Essentia worker by
 * downloading a static stream to disk (path the Python analyzer expects).
 */

import path from "path";
import { createWriteStream } from "fs";
import { mkdir, stat, unlink } from "fs/promises";
import { pipeline } from "stream/promises";
import axios from "axios";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import {
    getJellyfinConfig,
    getJellyfinStreamUrl,
    isJellyfinMusicSource,
    JELLYFIN_PREFIX,
} from "./jellyfin";
import {
    markAudioAnalysisStarted,
    recordAudioAnalysisFailed,
} from "./jellyfinTrackAnalysisService";

const ANALYSIS_QUEUE = "audio:analysis:queue";
const ESSENTIA_JELLYFIN_SUBDIR = "essentia-jellyfin";
const MAX_ESSENTIA_RETRIES = 3;
const STREAM_TIMEOUT_MS = 900_000;

function rawItemId(jellyfinTrackId: string): string | null {
    if (!jellyfinTrackId.startsWith(JELLYFIN_PREFIX)) return null;
    const raw = jellyfinTrackId.slice(JELLYFIN_PREFIX.length);
    return /^[a-f0-9]{32}$/i.test(raw) ? raw : null;
}

async function ensureCachedStreamFile(
    jellyfinTrackId: string
): Promise<string | null> {
    const raw = rawItemId(jellyfinTrackId);
    if (!raw) return null;

    const dir = path.join(config.music.transcodeCachePath, ESSENTIA_JELLYFIN_SUBDIR);
    await mkdir(dir, { recursive: true });
    const dest = path.join(dir, `${raw}.audio`);

    try {
        const st = await stat(dest);
        if (st.size > 64 * 1024) return dest;
        await unlink(dest).catch(() => {});
    } catch {
        /* fetch fresh */
    }

    const cfg = await getJellyfinConfig();
    if (!cfg) {
        logger.warn("[JellyfinEssentia] No Jellyfin config; skip download");
        return null;
    }

    const url = await getJellyfinStreamUrl(cfg, raw);
    const response = await axios.get(url, {
        responseType: "stream",
        timeout: STREAM_TIMEOUT_MS,
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 300,
    });

    const writer = createWriteStream(dest);
    try {
        await pipeline(response.data, writer);
    } catch (e) {
        await unlink(dest).catch(() => {});
        throw e;
    }

    return dest;
}

/**
 * Queue up to `limit` Jellyfin tracks that need Essentia analysis.
 * Downloads each static stream into the transcode cache, then pushes
 * `audio:analysis:queue` jobs (absolute `filePath`; Python joins safely).
 */
export async function queueJellyfinTracksForEssentia(
    limit = 5
): Promise<number> {
    if (!(await isJellyfinMusicSource())) return 0;

    const rows = await prisma.$queryRaw<{ jellyfinId: string }[]>`
        SELECT j."jellyfinId"
        FROM "JellyfinTrackMetadata" j
        LEFT JOIN "JellyfinTrackAnalysis" a ON a."jellyfinTrackId" = j."jellyfinId"
        WHERE (
            a."jellyfinTrackId" IS NULL
            OR (
                a."analysisStatus" IN ('pending', 'failed')
                AND COALESCE(a."analysisRetryCount", 0) < ${MAX_ESSENTIA_RETRIES}
            )
        )
        AND (
            a."jellyfinTrackId" IS NULL
            OR a."analysisStatus" IS DISTINCT FROM 'processing'
        )
        ORDER BY j."updatedAt" DESC
        LIMIT ${limit}
    `;

    if (rows.length === 0) return 0;

    let queued = 0;

    for (const row of rows) {
        const jellyfinTrackId = row.jellyfinId;
        try {
            const filePath = await ensureCachedStreamFile(jellyfinTrackId);
            if (!filePath) {
                await recordAudioAnalysisFailed(
                    jellyfinTrackId,
                    "Could not download Jellyfin stream for analysis"
                );
                continue;
            }
            await markAudioAnalysisStarted(jellyfinTrackId);
            await redisClient.rPush(
                ANALYSIS_QUEUE,
                JSON.stringify({
                    trackId: jellyfinTrackId,
                    filePath,
                    duration: 0,
                })
            );
            queued++;
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn(
                `[JellyfinEssentia] Failed to queue ${jellyfinTrackId}: ${msg}`
            );
            await recordAudioAnalysisFailed(jellyfinTrackId, msg).catch(() => {});
        }
    }

    if (queued > 0) {
        logger.debug(
            `[JellyfinEssentia] Queued ${queued} Jellyfin track(s) for Essentia`
        );
    }
    return queued;
}
