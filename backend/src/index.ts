import { config } from "./config";
import { logger } from "./utils/logger";
import { createApp } from "./server/app";
import { registerRoutes } from "./server/routes";
import {
    checkPasswordReset,
    checkPostgresConnection,
    checkRedisConnection,
    startHealthMonitor,
} from "./server/healthChecks";
import { runPostStartupTasks } from "./server/postStartup";
import { startEventLoopMonitor } from "./server/eventLoopMonitor";
import { installLifecycleHandlers } from "./server/lifecycle";

const app = createApp();
registerRoutes(app);

const server = app.listen(config.port, "0.0.0.0", async () => {
    // Server timeouts:
    // - 2min request timeout catches stuck handlers (uploads, long DB ops).
    // - 5min keep-alive prevents the Next.js proxy in the same container
    //   from reusing a connection the backend already closed (the 65s
    //   default caused ECONNRESET / "socket hang up" under load).
    server.timeout = 120 * 1000;
    server.keepAliveTimeout = 300 * 1000;
    server.headersTimeout = 301 * 1000;

    await checkPostgresConnection();
    await checkRedisConnection();
    await checkPasswordReset();

    logger.debug(
        `Lidifin API running on port ${config.port} (accessible on all network interfaces)`
    );

    await runPostStartupTasks(app);
});

startEventLoopMonitor();
installLifecycleHandlers(server);
startHealthMonitor();
