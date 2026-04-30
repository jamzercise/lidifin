import type { Router } from "express";
import { logger } from "../../utils/logger";
import { enrichmentService } from "../../services/enrichment";

/** GET/PUT per-user enrichment toggle/settings */
export function registerEnrichmentUserSettingsRoutes(router: Router): void {
    router.get("/settings", async (req, res) => {
        try {
            const userId = req.user!.id;
            const settings = await enrichmentService.getSettings(userId);
            res.json(settings);
        } catch (error) {
            logger.error("Get enrichment settings error:", error);
            res.status(500).json({ error: "Failed to get settings" });
        }
    });

    router.put("/settings", async (req, res) => {
        try {
            const userId = req.user!.id;
            const settings = await enrichmentService.updateSettings(
                userId,
                req.body,
            );
            res.json(settings);
        } catch (error) {
            logger.error("Update enrichment settings error:", error);
            res.status(500).json({ error: "Failed to update settings" });
        }
    });
}
