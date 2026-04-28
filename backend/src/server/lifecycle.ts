import type { Server } from "http";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";

/**
 * Wire up graceful shutdown on SIGTERM/SIGINT, and global handlers for
 * unhandledRejection / uncaughtException.
 *
 * - unhandledRejection: log only, keep running (silent crashes hurt
 *   more than the rejected promise).
 * - uncaughtException: attempt graceful shutdown, then exit 1.
 *
 * Pass the HTTP server so we drain in-flight requests before closing
 * Redis, queues, and Prisma.
 */
export function installLifecycleHandlers(server: Server): void {
    let isShuttingDown = false;

    async function gracefulShutdown(signal: string): Promise<void> {
        if (isShuttingDown) {
            logger.debug("Shutdown already in progress...");
            return;
        }
        isShuttingDown = true;
        logger.debug(`\nReceived ${signal}. Starting graceful shutdown...`);

        try {
            logger.debug("Closing HTTP server...");
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });

            // API only adds jobs; processors run in a separate worker process.
            const { closeAllQueues } = await import("../workers/queues");
            await closeAllQueues();

            logger.debug("Closing Redis connection...");
            await redisClient.quit();

            logger.debug("Closing database connection...");
            await prisma.$disconnect();

            logger.debug("Graceful shutdown complete");
            process.exit(0);
        } catch (error) {
            logger.error("Error during shutdown:", error);
            process.exit(1);
        }
    }

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));

    process.on("unhandledRejection", (reason) => {
        logger.error("Unhandled Promise Rejection:", {
            reason: reason instanceof Error ? reason.message : String(reason),
            stack: reason instanceof Error ? reason.stack : undefined,
        });
    });

    process.on("uncaughtException", (error) => {
        logger.error("Uncaught Exception - initiating graceful shutdown:", {
            message: error.message,
            stack: error.stack,
        });
        gracefulShutdown("uncaughtException").catch(() => {
            process.exit(1);
        });
    });
}
