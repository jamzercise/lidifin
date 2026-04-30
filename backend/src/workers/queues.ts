import { Queue } from "bullmq";
import { logger } from "../utils/logger";
import { getBullMqConnection } from "./queueConnection";

const connection = getBullMqConnection();

const SEVEN_DAYS_SEC = 7 * 24 * 60 * 60;
const FOURTEEN_DAYS_SEC = 14 * 24 * 60 * 60;

const defaultQueueOptions = {
    connection,
    defaultJobOptions: {
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

/** Worker tuning (mirrors former Bull stalled/lock settings). */
export const workerStallSettings = {
    stalledInterval: 30_000,
    lockDuration: 30_000,
    maxStalledCount: 1,
} as const;

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
