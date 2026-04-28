import { createClient, RedisClientType } from "redis";
import { logger } from "./logger";
import { config } from "../config";

// Skip the auto-connect and reconnect loop under Jest. Without this, the
// open TCP socket / reconnect timer keeps Node's event loop alive past the
// last test and `npm test` hangs indefinitely (we've previously seen
// processes stuck for 23+ hours). Every redis call site in this codebase
// is wrapped in try/catch (or `.catch()`), so a disconnected client just
// throws, gets logged, and execution continues — same behaviour as a
// failed connect, but without the dangling handle.
const isTest = process.env.NODE_ENV === "test";

const redisClient = createClient({
    url: config.redisUrl,
    ...(isTest ? { socket: { reconnectStrategy: false as const } } : {}),
});

redisClient.on("error", (err) => {
    // In test mode we expect "connection refused" / "client is closed"
    // errors because we never call connect(). Suppress to keep test output
    // readable; real runtime errors are surfaced as before.
    if (isTest) return;
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

if (!isTest) {
    redisClient.connect().catch((error) => {
        logger.error("  Redis connection failed:", error.message);
        logger.debug(" Continuing without Redis caching...");
    });
}

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
