import { createClient, RedisClientType } from "redis";
import { logger } from "./logger";
import { config } from "../config";

const redisClient = createClient({ url: config.redisUrl });

redisClient.on("error", (err) => {
    logger.error("  Redis error:", err.message);
});

redisClient.on("disconnect", () => {
    logger.debug("  Redis disconnected - caching disabled");
});

redisClient.on("reconnecting", () => {
    logger.debug(" Redis reconnecting...");
});

redisClient.on("ready", () => {
    logger.debug("Redis ready");
});

redisClient.connect().catch((error) => {
    logger.error("  Redis connection failed:", error.message);
    logger.debug(" Continuing without Redis caching...");
});

/**
 * Create a dedicated Redis connection (e.g. for pub/sub which requires its own client).
 * Caller is responsible for calling `.disconnect()` when done.
 */
export async function createDedicatedRedis(): Promise<RedisClientType> {
    const client = createClient({ url: config.redisUrl }) as RedisClientType;
    client.on("error", (err) => {
        logger.error("  Redis (dedicated) error:", err.message);
    });
    await client.connect();
    return client;
}

export { redisClient };
