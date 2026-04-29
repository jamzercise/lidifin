import type { Router } from "express";
import { logger } from "../../utils/logger";
import { clearDiscoveryLibraryForUser } from "../../services/discovery/clearDiscoveryLibrary";

/**
 * DELETE /discover/clear — finalize a discovery batch: move LIKED albums into the library and tear down the rest (Lidarr + filesystem + DB).
 */
export function registerClearLibraryRoute(router: Router): void {
    router.delete("/clear", async (req, res) => {
        try {
            const userId = req.user!.id;
            const result = await clearDiscoveryLibraryForUser(userId);
            res.json(result);
        } catch (error: unknown) {
            const err = error as { message?: string; stack?: string };
            logger.error(
                "Clear discovery playlist error:",
                err?.message || error
            );
            logger.error("Stack:", err?.stack);
            res.status(500).json({
                error: "Failed to clear discovery playlist",
                details: err?.message || "Unknown error",
            });
        }
    });
}
