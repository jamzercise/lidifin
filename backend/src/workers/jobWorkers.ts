import { Worker } from "bullmq";
import { getBullMqConnection } from "./queueConnection";
import { workerStallSettings } from "./queues";
import { processScan } from "./processors/scanProcessor";
import { processDiscoverWeekly } from "./processors/discoverProcessor";
import { processImageOptimization } from "./processors/imageProcessor";
import { processValidation } from "./processors/validationProcessor";

const connection = getBullMqConnection();

const baseWorkerOpts = {
    connection,
    ...workerStallSettings,
} as const;

/** One worker per queue — partitioned by Redis queue name (job type). */
export const scanWorker = new Worker(
    "library-scan",
    async (job) => {
        if (job.name === "scan") {
            return processScan(job);
        }
        throw new Error(`Unknown library-scan job: ${job.name}`);
    },
    { ...baseWorkerOpts, concurrency: 1 },
);

export const discoverWorker = new Worker(
    "discover-weekly",
    (job) => processDiscoverWeekly(job),
    { ...baseWorkerOpts, concurrency: 1 },
);

export const imageWorker = new Worker(
    "image-optimization",
    (job) => processImageOptimization(job),
    baseWorkerOpts,
);

export const validationWorker = new Worker(
    "file-validation",
    (job) => processValidation(job),
    baseWorkerOpts,
);

export const bullMqWorkers = [
    scanWorker,
    discoverWorker,
    imageWorker,
    validationWorker,
];
