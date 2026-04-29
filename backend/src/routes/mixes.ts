import { Router } from "express";
import { requireAuthOrToken } from "../middleware/auth";
import { registerMixAudiomuseRoutes } from "./mixes/audiomuse";
import { registerMixLibraryRoute } from "./mixes/library";
import { registerMixMoodRoutes } from "./mixes/mood";
import { registerMixDetailRoutes } from "./mixes/detail";

/**
 * Programmatic mixes + AudioMuse + mood flows. Decomposed from a single large
 * file; mount order matches the old monolith for identical Express matching.
 */
const router = Router();

router.use(requireAuthOrToken);

registerMixAudiomuseRoutes(router);
registerMixLibraryRoute(router);
registerMixMoodRoutes(router);
registerMixDetailRoutes(router);

export default router;
