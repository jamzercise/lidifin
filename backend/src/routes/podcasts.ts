import { Router } from "express";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import { registerPodcastCoversSyncRoute } from "./podcasts/coversSync";
import { registerPodcastLibraryAndDiscoverRoutes } from "./podcasts/libraryAndDiscover";
import { registerPodcastCrudRoutes } from "./podcasts/crud";
import { registerPodcastEpisodeRoutes } from "./podcasts/episodeRoutes";
import { registerPodcastRecommendationsAndCoversRoutes } from "./podcasts/recommendationsAndCovers";

/**
 * Podcast routes were split from a single ~1.8k-line file into modules under
 * `./podcasts/`. Mount order matches the former monolith so path matching stays
 * identical. `refreshPodcastFeed` lives in `services/podcastFeedRefresh` but is
 * re-exported here for any legacy imports of `@/routes/podcasts`.
 */
const router = Router();

registerPodcastCoversSyncRoute(router, requireAuth);

router.use(requireAuthOrToken);

registerPodcastLibraryAndDiscoverRoutes(router);
registerPodcastCrudRoutes(router);
registerPodcastEpisodeRoutes(router);
registerPodcastRecommendationsAndCoversRoutes(router);

export { refreshPodcastFeed } from "../services/podcastFeedRefresh";
export default router;
