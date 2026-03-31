import { Router } from "express";
import { logger, JELLYFIN_UNREACHABLE_MESSAGE } from "./_helpers";
import {
    getJellyfinConfig,
    getJellyfinFavorites,
    addJellyfinFavorite,
    removeJellyfinFavorite,
} from "../../services/jellyfin";

const router = Router();

// GET /library/favorites - Jellyfin favorites (live view)
router.get("/favorites", async (req, res) => {
    try {
        const cfg = await getJellyfinConfig();
        if (!cfg) {
            return res.status(503).json({
                error: JELLYFIN_UNREACHABLE_MESSAGE,
                jellyfin: true,
            });
        }
        const tracks = await getJellyfinFavorites(cfg);
        return res.json({ tracks });
    } catch (err: any) {
        logger.warn("[Library] Jellyfin favorites error:", err?.message);
        return res.status(503).json({
            error: JELLYFIN_UNREACHABLE_MESSAGE,
            jellyfin: true,
        });
    }
});

// POST /library/favorites/:trackId - Add Jellyfin favorite
router.post("/favorites/:trackId", async (req, res) => {
    try {
        const trackId = req.params.trackId;
        if (!trackId.startsWith("jellyfin:")) {
            return res.status(400).json({ error: "Only Jellyfin tracks can be favorited here." });
        }
        const cfg = await getJellyfinConfig();
        if (!cfg) {
            return res.status(503).json({ error: JELLYFIN_UNREACHABLE_MESSAGE, jellyfin: true });
        }
        const rawId = trackId.slice("jellyfin:".length);
        await addJellyfinFavorite(cfg, rawId);
        return res.json({ success: true, favorited: true });
    } catch (err: any) {
        const msg = err?.response?.data?.message ?? err?.message ?? "Jellyfin unreachable";
        logger.warn("[Library] Jellyfin add favorite error:", msg);
        return res.status(503).json({
            error: JELLYFIN_UNREACHABLE_MESSAGE,
            detail: msg,
            jellyfin: true,
        });
    }
});

// DELETE /library/favorites/:trackId - Remove Jellyfin favorite
router.delete("/favorites/:trackId", async (req, res) => {
    try {
        const trackId = req.params.trackId;
        if (!trackId.startsWith("jellyfin:")) {
            return res.status(400).json({ error: "Only Jellyfin tracks can be unfavorited here." });
        }
        const cfg = await getJellyfinConfig();
        if (!cfg) {
            return res.status(503).json({ error: JELLYFIN_UNREACHABLE_MESSAGE, jellyfin: true });
        }
        const rawId = trackId.slice("jellyfin:".length);
        await removeJellyfinFavorite(cfg, rawId);
        return res.json({ success: true, favorited: false });
    } catch (err: any) {
        const msg = err?.response?.data?.message ?? err?.message ?? "Jellyfin unreachable";
        logger.warn("[Library] Jellyfin remove favorite error:", msg);
        return res.status(503).json({
            error: JELLYFIN_UNREACHABLE_MESSAGE,
            detail: msg,
            jellyfin: true,
        });
    }
});

export default router;
