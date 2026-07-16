import { Worker } from "bullmq";
import { getBullMqConnection } from "./queueConnection";
import { longJobWorkerSettings, shortJobWorkerSettings } from "./queues";
import { processScan } from "./processors/scanProcessor";
import { processDiscoverWeekly } from "./processors/discoverProcessor";
import { processImageOptimization } from "./processors/imageProcessor";
import { processValidation } from "./processors/validationProcessor";

const connection = getBullMqConnection();

// Scan and discover are long-running; give them long locks so they aren't
// falsely flagged as stalled and killed mid-run.
const longJobWorkerOpts = {
    connection,
    ...longJobWorkerSettings,
} as const;

// Image/validation are short; keep tight locks to reclaim dead workers fast.
const shortJobWorkerOpts = {
    connection,
    ...shortJobWorkerSettings,
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
    { ...longJobWorkerOpts, concurrency: 1 },
);

export const discoverWorker = new Worker(
    "discover-weekly",
    (job) => processDiscoverWeekly(job),
    { ...longJobWorkerOpts, concurrency: 1 },
);

export const imageWorker = new Worker(
    "image-optimization",
    (job) => processImageOptimization(job),
    shortJobWorkerOpts,
);

export const validationWorker = new Worker(
    "file-validation",
    (job) => processValidation(job),
    shortJobWorkerOpts,
);

export const bullMqWorkers = [
    scanWorker,
    discoverWorker,
    imageWorker,
    validationWorker,
];
