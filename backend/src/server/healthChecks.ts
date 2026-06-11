import { config } from "../config";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import {
    recordDependencyFailure,
    recordDependencySuccess,
} from "./runtimeHealth";

/**
 * Verify Postgres is reachable. Exits the process on failure — startup
 * cannot continue without a database, and we'd rather fail fast than
 * limp along with broken queries.
 */
export async function checkPostgresConnection(): Promise<void> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        recordDependencySuccess("postgres");
        logger.debug("✓ PostgreSQL connection verified");
    } catch (error) {
        const message =
            error instanceof Error ? error.message : String(error);
        recordDependencyFailure("postgres", message);
        logger.error("✗ PostgreSQL connection failed:", {
            error: message,
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
        recordDependencySuccess("redis");
        logger.debug("✓ Redis connection verified");
    } catch (error) {
        const message =
            error instanceof Error ? error.message : String(error);
        recordDependencyFailure("redis", message);
        logger.error("✗ Redis connection failed:", {
            error: message,
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
const HEALTH_CHECK_INTERVAL = 60 * 1000;

export function startHealthMonitor(): void {
    const timer = setInterval(async () => {
        const postgresResult = await prisma.$queryRaw`SELECT 1`
            .then(() => ({ ok: true as const }))
            .catch((error: unknown) => ({ ok: false as const, error }));

        if (postgresResult.ok) {
            recordDependencySuccess("postgres");
        } else {
            const message =
                postgresResult.error instanceof Error
                    ? postgresResult.error.message
                    : String(postgresResult.error);
            recordDependencyFailure("postgres", message);
            logger.error("Health check failed - PostgreSQL unhealthy:", {
                error: message,
            });
            try {
                await prisma.$disconnect();
                await prisma.$connect();
                recordDependencySuccess("postgres");
                logger.debug("Database connection recovered");
            } catch (reconnectError) {
                const reconnectMessage =
                    reconnectError instanceof Error
                        ? reconnectError.message
                        : String(reconnectError);
                recordDependencyFailure("postgres", reconnectMessage);
                logger.error(
                    "Failed to recover database connection:",
                    reconnectError
                );
            }
        }

        if (!redisClient.isReady) {
            recordDependencyFailure(
                "redis",
                "Redis client is not ready - connection failed or still connecting"
            );
            logger.error("Health check failed - Redis unhealthy:", {
                error: "Redis client is not ready - connection failed or still connecting",
            });
            return;
        }

        try {
            await redisClient.ping();
            recordDependencySuccess("redis");
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            recordDependencyFailure("redis", message);
            logger.error("Health check failed - Redis unhealthy:", {
                error: message,
            });
        }
    }, HEALTH_CHECK_INTERVAL);

    timer.unref?.();
}
