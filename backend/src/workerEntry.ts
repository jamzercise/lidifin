/**
 * Worker process entrypoint – runs BullMQ job workers and background workers only.
 * Run separately from the API so heavy jobs (scan, discover, etc.) don't share CPU/DB with HTTP.
 *
 * Usage: node dist/workerEntry.js
 * In Docker all-in-one: supervisord starts both the API (index.js) and this worker.
 */

import { prisma } from "./utils/db";
import { logger } from "./utils/logger";

async function main() {
    logger.info("[Worker] Starting worker process (BullMQ + enrichment + cron)");
    await import("./workers");
    logger.info("[Worker] Worker process running");
}

async function shutdown(signal: string) {
    logger.info(`[Worker] Received ${signal}, shutting down...`);
    try {
        const { shutdownWorkers } = await import("./workers");
        await shutdownWorkers();
    } catch (err) {
        logger.error("[Worker] Error during worker shutdown:", err);
    }
    await prisma.$disconnect();
    logger.info("[Worker] Shutdown complete");
    process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((err) => {
    logger.error("[Worker] Fatal error:", err);
    process.exit(1);
});
