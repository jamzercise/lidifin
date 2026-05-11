import { Router } from "express";
import { requireAuthOrToken } from "../middleware/auth";
import { registerJobsRoutes } from "./discover/jobs";
import { registerFeedbackRoutes } from "./discover/feedback";
import { registerConfigRoutes } from "./discover/config";
import { registerClearLibraryRoute } from "./discover/clearLibrary";
import { registerExclusionsRoutes } from "./discover/exclusions";
import { registerCleanupRoutes } from "./discover/cleanup";
import { registerSavedAlbumsRoutes } from "./discover/savedAlbums";

/**
 * Discover Weekly routes.
 *
 * The original file was a 2,129-line monolith mixing six distinct
 * concerns (batch jobs, feedback, config, library cleanup, exclusion
 * management, Lidarr cleanup). It has been decomposed into per-area
 * modules under `./discover/`; this file is the thin assembler that
 * mounts them in order onto a single Router so the shared
 * `requireAuthOrToken` middleware applies to all handlers.
 *
 * Public route paths are unchanged.
 */
const router = Router();

router.use(requireAuthOrToken);

registerSavedAlbumsRoutes(router);
registerJobsRoutes(router);
registerFeedbackRoutes(router);
registerConfigRoutes(router);
registerClearLibraryRoute(router);
registerExclusionsRoutes(router);
registerCleanupRoutes(router);

export default router;
