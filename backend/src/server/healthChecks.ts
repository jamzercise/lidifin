import { config } from "../config";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

/**
 * Verify Postgres is reachable. Exits the process on failure — startup
 * cannot continue without a database, and we'd rather fail fast than
 * limp along with broken queries.
 */
export async function checkPostgresConnection(): Promise<void> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        logger.debug("✓ PostgreSQL connection verified");
    } catch (error) {
        logger.error("✗ PostgreSQL connection failed:", {
            error: error instanceof Error ? error.message : String(error),
            databaseUrl: config.databaseUrl?.replace(/:[^:@]+@/, ":***@"),
        });
        logger.error("Unable to connect to PostgreSQL. Please ensure:");
        logger.error(
            "  1. PostgreSQL is running on the correct port (default: 5433)"
        );
        logger.error("  2. DATABASE_URL in .env is correct");
        logger.error("  3. Database credentials are valid");
        process.exit(1);
    }
}

/**
 * Verify Redis is reachable. Like Postgres: exit on failure.
 */
export async function checkRedisConnection(): Promise<void> {
    try {
        if (!redisClient.isReady) {
            throw new Error(
                "Redis client is not ready - connection failed or still connecting"
            );
        }
        await redisClient.ping();
        logger.debug("✓ Redis connection verified");
    } catch (error) {
        logger.error("✗ Redis connection failed:", {
            error: error instanceof Error ? error.message : String(error),
            redisUrl: config.redisUrl?.replace(/:[^:@]+@/, ":***@"),
        });
        logger.error("Unable to connect to Redis. Please ensure:");
        logger.error(
            "  1. Redis is running on the correct port (default: 6380)"
        );
        logger.error("  2. REDIS_URL in .env is correct");
        process.exit(1);
    }
}

/**
 * Reset the admin password if ADMIN_RESET_PASSWORD env var is set.
 * Intended as an escape hatch for self-hosted users who lock themselves
 * out; the warn message reminds them to remove the env var afterwards.
 */
export async function checkPasswordReset(): Promise<void> {
    const resetPassword = process.env.ADMIN_RESET_PASSWORD;
    if (!resetPassword) return;

    const bcrypt = await import("bcrypt");
    const adminUser = await prisma.user.findFirst({ where: { role: "ADMIN" } });
    if (!adminUser) {
        logger.warn("[Password Reset] No admin user found");
        return;
    }

    const hashedPassword = await bcrypt.hash(resetPassword, 10);
    await prisma.user.update({
        where: { id: adminUser.id },
        data: { passwordHash: hashedPassword },
    });
    logger.warn(
        "[Password Reset] Admin password has been reset via ADMIN_RESET_PASSWORD env var. Remove this env var and restart."
    );
}

/**
 * Periodic Postgres + Redis ping to keep idle connections alive and
 * surface stale-connection issues early. Attempts a Prisma reconnect
 * if the database ping fails.
 */
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;

export function startHealthMonitor(): void {
    setInterval(async () => {
        try {
            await prisma.$queryRaw`SELECT 1`;
            if (redisClient.isReady) {
                await redisClient.ping();
            }
        } catch (error) {
            logger.error("Health check failed - connections may be stale:", {
                error: error instanceof Error ? error.message : String(error),
            });
            try {
                await prisma.$disconnect();
                await prisma.$connect();
                logger.debug("Database connection recovered");
            } catch (reconnectError) {
                logger.error(
                    "Failed to recover database connection:",
                    reconnectError
                );
            }
        }
    }, HEALTH_CHECK_INTERVAL);
}
