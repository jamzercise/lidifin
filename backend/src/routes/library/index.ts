import { Router } from "express";
import { requireAuthOrToken } from "../../middleware/auth";
import { apiLimiter } from "../../middleware/rateLimiter";
import { config } from "../../config";
import { logger } from "../../utils/logger";

import importRouter from "./import";
import artistsRouter from "./artists";
import albumsRouter from "./albums";
import tracksRouter from "./tracks";
import streamingRouter from "./streaming";
import favoritesRouter from "./favorites";
import browseRouter from "./browse";

const router = Router();

router.use(requireAuthOrToken);

router.use((req, res, next) => {
    if (req.path.startsWith("/cover-art") || req.path.includes("/stream")) {
        return next();
    }
    return apiLimiter(req, res, next);
});

const LOG_TIMING = process.env.LOG_TIMING === "1" || config.nodeEnv === "development";
const TIMING_PATTERNS = ["/artists", "/albums"];
router.use((req, res, next) => {
    if (!LOG_TIMING || !TIMING_PATTERNS.some((p) => req.path.startsWith(p))) return next();
    const start = Date.now();
    res.once("finish", () => {
        const ms = Date.now() - start;
        if (ms > 500) logger.debug(`[TIMING] ${req.method} ${req.path} ${ms}ms`);
    });
    next();
});

router.use(importRouter);
router.use(browseRouter);
router.use(artistsRouter);
router.use(albumsRouter);
router.use(tracksRouter);
router.use(streamingRouter);
router.use(favoritesRouter);

export default router;
