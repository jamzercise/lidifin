import type { Router, RequestHandler } from "express";
import { logger } from "../../utils/logger";
import { podcastCacheService } from "../../services/podcastCache";

/**
 * POST /podcasts/sync-covers — manual cover sync (requires full session auth).
 */
export function registerPodcastCoversSyncRoute(
    router: Router,
    requireAuth: RequestHandler,
): void {
    router.post("/sync-covers", requireAuth, async (req, res) => {
        try {
            const { notificationService } =
                await import("../../services/notificationService");
            logger.debug(" Starting podcast cover sync...");

            const podcastResult = await podcastCacheService.syncAllCovers();
            const episodeResult = await podcastCacheService.syncEpisodeCovers();

            await notificationService.notifySystem(
                req.user!.id,
                "Podcast Covers Synced",
                `Synced ${podcastResult.synced || 0} podcast covers and ${
                    episodeResult.synced || 0
                } episode covers`,
            );

            res.json({
                success: true,
                podcasts: podcastResult,
                episodes: episodeResult,
            });
        } catch (error: any) {
            logger.error("Podcast cover sync failed:", error);
            res.status(500).json({
                error: "Sync failed",
                message: error.message,
            });
        }
    });
}
