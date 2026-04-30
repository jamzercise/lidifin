import type { ConnectionOptions } from "bullmq";
import { config } from "../config";

/** Shared Redis connection options for BullMQ Queue / Worker instances. */
export function getBullMqConnection(): ConnectionOptions {
    const redisUrl = new URL(config.redisUrl);
    const connection: ConnectionOptions = {
        host: redisUrl.hostname,
        port: parseInt(redisUrl.port || "6379", 10),
    };
    if (redisUrl.password) {
        connection.password = decodeURIComponent(redisUrl.password);
    }
    if (redisUrl.username) {
        connection.username = decodeURIComponent(redisUrl.username);
    }
    const pathPart = redisUrl.pathname.replace(/^\//, "");
    if (pathPart !== "" && !Number.isNaN(Number(pathPart))) {
        connection.db = parseInt(pathPart, 10);
    }
    return connection;
}
