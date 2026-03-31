import Bull from "bull";
import { logger } from "../utils/logger";
import { config } from "../config";

// Parse Redis URL for Bull configuration
const redisUrl = new URL(config.redisUrl);
const redisConfig = {
    host: redisUrl.hostname,
    port: parseInt(redisUrl.port) || 6379,
};

// Default queue settings for better stability
const defaultQueueSettings: Bull.QueueOptions["settings"] = {
    // Check for stalled jobs every 30 seconds
    stalledInterval: 30000,
    // Mark a job as stalled if it hasn't reported progress in 30 seconds
    lockDuration: 30000,
    // Retry stalled jobs once before marking as failed
    maxStalledCount: 1,
};

// Create queues with stability settings
export const scanQueue = new Bull("library-scan", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

export const discoverQueue = new Bull("discover-weekly", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

export const imageQueue = new Bull("image-optimization", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

export const validationQueue = new Bull("file-validation", {
    redis: redisConfig,
    settings: defaultQueueSettings,
});

// Export all queues for monitoring
export const queues = [scanQueue, discoverQueue, imageQueue, validationQueue];

// Add error handlers to all queues to prevent unhandled exceptions
queues.forEach((queue) => {
    queue.on("error", (error) => {
        logger.error(`Bull queue error (${queue.name}):`, {
            message: error.message,
            stack: error.stack,
        });
    });

    queue.on("stalled", (job) => {
        logger.warn(`Bull job stalled (${queue.name}):`, {
            jobId: job.id,
            data: job.data,
        });
    });
});

// Close all queues (for API process shutdown; worker process uses shutdownWorkers() instead)
export async function closeAllQueues(): Promise<void> {
    await Promise.all([
        scanQueue.close(),
        discoverQueue.close(),
        imageQueue.close(),
        validationQueue.close(),
    ]);
    logger.debug("Bull queues closed");
}

// Log queue initialization
logger.debug("Bull queues initialized with stability settings");
