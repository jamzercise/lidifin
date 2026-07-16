import { Queue } from "bullmq";
import { logger } from "../utils/logger";
import { getBullMqConnection } from "./queueConnection";

const connection = getBullMqConnection();

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
const FOURTEEN_DAYS_SEC = 14 * 24 * 60 * 60;

const defaultQueueOptions = {
    connection,
    defaultJobOptions: {
        // Retry transient failures with exponential backoff. Processors now
        // throw on failure (rather than resolving with { success: false }),
        // so BullMQ actually sees the failure and applies these retries.
        attempts: 3,
        backoff: {
            type: "exponential" as const,
            delay: 30_000, // 30s, 60s, 120s
        },
        removeOnComplete: {
            age: SEVEN_DAYS_SEC,
            count: 5000,
        },
        removeOnFail: {
            age: FOURTEEN_DAYS_SEC,
            count: 10000,
        },
    },
} as const;

/**
 * Per-queue worker tuning.
 *
 * `lockDuration` is how long a job's lock is held before BullMQ considers it
 * stalled. Scan and Discover Weekly are long, often CPU-bound jobs that can
 * run for many minutes and transiently block the event loop (which delays
 * lock renewal). The old flat 30s lock caused false "stalled" detections and
 * with `maxStalledCount: 1` those jobs were killed and re-run mid-flight.
 * We give the long-running queues generous locks; short queues keep tight
 * ones so genuinely dead workers are reclaimed quickly.
 */
export const longJobWorkerSettings = {
    stalledInterval: 60_000,
    lockDuration: 20 * 60_000, // 20 minutes
    maxStalledCount: 2,
} as const;

export const shortJobWorkerSettings = {
    stalledInterval: 30_000,
    lockDuration: 60_000,
    maxStalledCount: 1,
} as const;

/** @deprecated Use longJobWorkerSettings / shortJobWorkerSettings. Kept for
 * any external importers. */
export const workerStallSettings = shortJobWorkerSettings;

export const scanQueue = new Queue("library-scan", defaultQueueOptions);
export const discoverQueue = new Queue("discover-weekly", defaultQueueOptions);
export const imageQueue = new Queue("image-optimization", defaultQueueOptions);
export const validationQueue = new Queue("file-validation", defaultQueueOptions);

export const queues = [
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
];

queues.forEach((queue) => {
    queue.on("error", (error: Error) => {
        logger.error(`BullMQ queue error (${queue.name}):`, {
            message: error.message,
            stack: error.stack,
        });
    });
});

export async function closeAllQueues(): Promise<void> {
    await Promise.all(queues.map((q) => q.close()));
    logger.debug("BullMQ queues closed");
}

logger.debug("BullMQ queues initialized");
